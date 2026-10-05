import { type Address, type Hex, getAddress } from "viem";

import { rows } from "../../lib/db";
import { protocolAddresses } from "../../lib/deployment";
import { DEAD, ZERO, lc } from "../../lib/indexer/addresses";
import { indexedUntil } from "../../lib/indexer/status";
import { type RewardLeaf, POOL_LEAF_ENCODING, buildRewardTree } from "../../lib/rewards/tree";
import { EPOCH_LENGTH_SEC, type TransferEvent, allocate, latestBoundary, timeWeightedBalances } from "../../lib/rewards/twab";
import { feeVaultAbi, holderRewardDistributorAbi } from "../../shared/abis";
import type { KeeperContext } from "../context";
import { simulateAndSend } from "../tx";

/**
 * Holder rewards, twice a day. When a 00:00 or 12:00 UTC boundary has passed (on chain time) and
 * the index has caught up to it, the keeper:
 *
 *   1. for every holder-mode coin, weighs each holder by their time-weighted balance over the window
 *      (pool, dEaD, the coin and every memefun contract never earn),
 *   2. splits the coin's pot (fees already pulled + still in FeeVault) pro rata, rounding down and
 *      dropping dust under $0.01; the rest stays in the pot for the next epoch,
 *   3. builds ONE Merkle tree over every coin's leaves, stores every leaf and proof, publishes the
 *      full leaf set to IPFS so anyone can recompute the root,
 *   4. calls publishEpoch. Claims open after the contract's 12-hour veto window.
 *
 * Idempotent: a crash after building but before publishing resumes with the same epoch.
 */
interface HolderCoin {
  address: string;
  quote: string;
  pool_id: Hex;
  decimals: number;
  price_usd_e_8: string;
}

export interface EpochResult {
  status: "published" | "waiting" | "skipped" | "failed" | "dry_run";
  reason?: string;
  epoch?: bigint;
  coins?: number;
  leaves?: number;
}

async function firstWindowStart(ctx: KeeperContext): Promise<number | null> {
  const [row] = await rows<{ first: number | null }>(ctx.index, `SELECT MIN(created_at) AS first FROM coin WHERE launched = true AND mode = 2`);
  return row?.first === null || row?.first === undefined ? null : Math.floor(Number(row.first) / EPOCH_LENGTH_SEC) * EPOCH_LENGTH_SEC;
}

async function balancesBefore(ctx: KeeperContext, coin: string, before: number): Promise<Map<string, bigint>> {
  const result = await rows<{ account: string; amount: string }>(
    ctx.index,
    `SELECT account, SUM(delta)::text AS amount FROM (
        SELECT "to" AS account, amount AS delta FROM transfer WHERE coin = $1 AND timestamp < $2
        UNION ALL
        SELECT "from" AS account, -amount AS delta FROM transfer WHERE coin = $1 AND timestamp < $2
     ) moves GROUP BY account HAVING SUM(delta) <> 0`,
    [coin, before],
  );
  return new Map(result.map((r) => [r.account, BigInt(r.amount)]));
}

async function transfersIn(ctx: KeeperContext, coin: string, start: number, end: number): Promise<TransferEvent[]> {
  const result = await rows<{ from: string; to: string; amount: string; timestamp: number }>(
    ctx.index,
    `SELECT "from", "to", amount::text AS amount, timestamp FROM transfer
      WHERE coin = $1 AND timestamp >= $2 AND timestamp < $3 ORDER BY block_number, log_index`,
    [coin, start, end],
  );
  return result.map((r) => ({ from: r.from, to: r.to, amount: BigInt(r.amount), timestamp: Number(r.timestamp) }));
}

export async function runEpochs(ctx: KeeperContext): Promise<EpochResult> {
  const d = ctx.deployment;
  const now = await ctx.chainNow();
  const onchainLast = await ctx.client.readContract({ address: d.holderRewardDistributor, abi: holderRewardDistributorAbi, functionName: "lastEpoch" });
  let last = await ctx.app.lastRewardEpoch();

  // Resume or clean up an epoch left half-done by a previous run.
  if (last && last.status === "built") {
    if (last.epoch <= onchainLast) {
      await ctx.appPool.query(`UPDATE reward_epoch SET status = 'published', published_at = COALESCE(published_at, now()) WHERE epoch = $1`, [last.epoch.toString()]);
      last = { ...last, status: "published" };
    } else if (last.epoch === onchainLast + 1n) {
      return publish(ctx, last.epoch);
    }
  }
  if (last && last.status === "failed") {
    await deleteEpoch(ctx, last.epoch);
    last = await ctx.app.lastRewardEpoch();
  }

  const windowStart = last ? last.windowEnd : await firstWindowStart(ctx);
  const windowEnd = latestBoundary(now);
  if (windowStart === null) return { status: "waiting", reason: "no holder-mode coins yet" };
  if (windowEnd <= windowStart) return { status: "waiting", reason: "window not over" };
  const indexed = await indexedUntil(ctx.index, ctx.chain.id);
  if (indexed === null || indexed < windowEnd) return { status: "waiting", reason: "index has not reached the window end" };

  const epoch = onchainLast + 1n;
  const excluded = new Set<string>([ZERO, DEAD, ...protocolAddresses(d).map(lc)]);
  const coins = await rows<HolderCoin>(
    ctx.index,
    `SELECT c.address, m.pool_id, m.quote, q.decimals, q.price_usd_e_8 FROM coin c JOIN market m ON m.address = c.address JOIN quote q ON q.address = m.quote
      WHERE c.launched = true AND c.mode = 2 AND c.created_at < $1 ORDER BY c.address, m.pool_id`,
    [windowEnd],
  );

  const leaves: RewardLeaf[] = [];
  const weightsByCoin = new Map<string, Map<string, bigint>>();
  const perCoin: Array<{ coin: Address; poolId: Hex; pot: bigint; total: bigint; holders: number }> = [];
  for (const c of coins) {
    const coin = getAddress(c.address);
    const quote = getAddress(c.quote);
    const [available, pending] = await Promise.all([
      ctx.client.readContract({ address: d.holderRewardDistributor, abi: holderRewardDistributorAbi, functionName: "availableFor", args: [coin, quote] }),
      ctx.client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "destinationPendingFor", args: [coin, quote] }),
    ]);
    const pot = available + pending;
    if (pot === 0n) continue;
    let weights = weightsByCoin.get(c.address);
    if (!weights) {
    weights = timeWeightedBalances({
      startBalances: await balancesBefore(ctx, c.address, windowStart),
      transfers: await transfersIn(ctx, c.address, windowStart, windowEnd),
      windowStart,
      windowEnd,
      excluded: new Set([...excluded, lc(c.address)]),
    }).weights;
    weightsByCoin.set(c.address, weights);
    }
    // Dust: shares worth under $0.01 are not worth claiming; with no price, 1 raw unit.
    const price = BigInt(c.price_usd_e_8);
    const minAmount = price > 0n ? (ctx.thresholds.rewardDustUsdE8 * 10n ** BigInt(c.decimals)) / price : 1n;
    const allocations = allocate(pot, weights, minAmount > 0n ? minAmount : 1n);
    if (allocations.length === 0) continue;
    let total = 0n;
    allocations.forEach((a, i) => {
      total += a.amount;
      leaves.push({ epoch, coin, poolId: c.pool_id, index: BigInt(i), account: getAddress(a.account), amount: a.amount });
    });
    perCoin.push({ coin, poolId: c.pool_id, pot, total, holders: allocations.length });
  }

  if (leaves.length === 0) {
    // Nothing to pay this window: it rolls into the next one, so no holder loses time.
    ctx.log("epoch.empty", { windowStart, windowEnd });
    return { status: "skipped", reason: "no rewards to distribute in this window" };
  }

  const tree = buildRewardTree(leaves);
  const document = new TextEncoder().encode(
    JSON.stringify({ epoch: epoch.toString(), windowStart, windowEnd, root: tree.root, leafEncoding: POOL_LEAF_ENCODING, tree: tree.dump }),
  );
  const leavesDoc = await ctx.media.put(document, "application/json");

  const client = await ctx.appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO reward_epoch (epoch, window_start, window_end, root, leaves, status, leaves_uri) VALUES ($1, $2, $3, $4, $5, 'built', $6)`,
      [epoch.toString(), windowStart, windowEnd, tree.root, leaves.length, leavesDoc.uri],
    );
    for (const c of perCoin) {
      await client.query(`INSERT INTO reward_epoch_coin (epoch, coin, pool_id, pot, total, holders) VALUES ($1, $2, $3, $4, $5, $6)`, [
        epoch.toString(),
        lc(c.coin),
        c.poolId,
        c.pot.toString(),
        c.total.toString(),
        c.holders,
      ]);
    }
    for (let i = 0; i < leaves.length; i += 1) {
      const leaf = leaves[i]!;
      await client.query(`INSERT INTO reward_leaf (epoch, coin, pool_id, idx, account, amount, proof) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`, [
        epoch.toString(),
        lc(leaf.coin),
        leaf.poolId,
        leaf.index.toString(),
        lc(leaf.account),
        leaf.amount.toString(),
        JSON.stringify(tree.proofs[i]),
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  ctx.log("epoch.built", { epoch, windowStart, windowEnd, root: tree.root, coins: perCoin.length, leaves: leaves.length, leavesUri: leavesDoc.uri });
  return publish(ctx, epoch);
}

async function deleteEpoch(ctx: KeeperContext, epoch: bigint) {
  for (const table of ["reward_leaf", "reward_epoch_coin", "reward_epoch"]) {
    await ctx.appPool.query(`DELETE FROM ${table} WHERE epoch = $1`, [epoch.toString()]);
  }
}

async function publish(ctx: KeeperContext, epoch: bigint): Promise<EpochResult> {
  const [row] = await rows<{ root: `0x${string}` }>(ctx.appPool, `SELECT root FROM reward_epoch WHERE epoch = $1`, [epoch.toString()]);
  const coins = await rows<{ coin: string; pool_id: Hex | null; total: string }>(ctx.appPool, `SELECT coin, pool_id, total::text AS total FROM reward_epoch_coin WHERE epoch = $1 ORDER BY coin, pool_id`, [epoch.toString()]);
  if (!row || coins.length === 0) throw new Error(`epoch ${epoch} has nothing stored to publish`);
  const poolFormat = Boolean(coins[0]!.pool_id);
  if (coins.some((c) => Boolean(c.pool_id) !== poolFormat)) throw new Error(`epoch ${epoch} mixes proof formats`);
  const outcome = poolFormat
    ? await simulateAndSend(ctx, ctx.wallets.publisher, {
        address: ctx.deployment.holderRewardDistributor, abi: holderRewardDistributorAbi, functionName: "publishEpochFor",
        args: [epoch, row.root, coins.map((c) => c.pool_id!), coins.map((c) => BigInt(c.total))],
      })
    : await simulateAndSend(ctx, ctx.wallets.publisher, {
        address: ctx.deployment.holderRewardDistributor, abi: holderRewardDistributorAbi, functionName: "publishEpoch",
        args: [epoch, row.root, coins.map((c) => getAddress(c.coin)), coins.map((c) => BigInt(c.total))],
      });
  if (outcome.kind === "no_wallet") return { status: "waiting", reason: "no publisher key configured", epoch };
  if (outcome.kind === "dry_run") {
    // A dry run must not leave a built epoch that a real run would then publish unseen.
    await deleteEpoch(ctx, epoch);
    await ctx.app.logKeeperRun({ job: "epoch", target: epoch.toString(), status: "dry_run", detail: { root: row.root, coins: coins.length } });
    return { status: "dry_run", epoch, coins: coins.length };
  }
  if (outcome.kind === "reverted") {
    await ctx.appPool.query(`UPDATE reward_epoch SET status = 'failed', error = $2 WHERE epoch = $1`, [epoch.toString(), outcome.error]);
    await ctx.app.logKeeperRun({ job: "epoch", target: epoch.toString(), status: "failed", detail: { reason: outcome.error } });
    ctx.log("epoch.failed", { epoch, reason: outcome.error });
    return { status: "failed", reason: outcome.error, epoch };
  }
  await ctx.appPool.query(`UPDATE reward_epoch SET status = 'published', tx_hash = $2, published_at = now() WHERE epoch = $1`, [epoch.toString(), outcome.hash]);
  await ctx.app.logKeeperRun({ job: "epoch", target: epoch.toString(), status: "ok", detail: { root: row.root, coins: coins.length }, txHash: outcome.hash });
  ctx.log("epoch.published", { epoch, root: row.root, coins: coins.length, tx: outcome.hash });
  return { status: "published", epoch, coins: coins.length };
}
