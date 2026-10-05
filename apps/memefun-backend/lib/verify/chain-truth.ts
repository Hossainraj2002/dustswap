import type { Pool } from "pg";
import {
  type Address,
  type PublicClient,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  hexToBigInt,
  keccak256,
  zeroAddress,
} from "viem";

import type { Deployment } from "../deployment";
import { aggregatePoolId } from "../market/derive";
import { tweetVaultReadAbi } from "../x/attestation";
import { COIN_SUPPLY, DEAD_ADDRESS } from "../../shared/core/constants";
import { buybackBurnVaultAbi, feeVaultAbi, floorVaultAbi, holderRewardDistributorAbi, memeFunHookAbi } from "../../shared/abis";

/**
 * Compares what the indexer wrote with what the contracts say, at the chain's latest block. Used by
 * `pnpm verify-index` during development and by the e2e suite. Returns every mismatch found;
 * an empty list means the index agrees with the chain.
 */

const POOLS_SLOT = 6n;
const extsloadAbi = [
  { type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ name: "", type: "bytes32" }] },
] as const;
const erc6909BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface TruthReport {
  coins: number;
  checks: number;
  failures: string[];
}

interface CoinRow {
  address: string;
  pool_id: `0x${string}`;
  creator: string;
  quote: string;
  fee_bps: number;
  sqrt_price_x_96: string;
  pool_quote: string;
  pool_coins: string;
  burned: string;
  trades: number;
  volume_quote: string;
  volume_usd_e_8: string;
  price_usd_e_18: string;
  holders: number;
  creator_earned: string;
  creator_claimed: string;
  destination_earned: string;
  destination_pulled: string;
  buyback_spent: string;
  buyback_burned: string;
  floor_quote: string;
  floor_near_tick: number | null;
  mode: number;
}

export async function verifyIndexAgainstChain(input: {
  pool: Pool;
  schema: string;
  client: PublicClient;
  deployment: Deployment;
}): Promise<TruthReport> {
  const { pool, client, deployment: d } = input;
  const schema = input.schema.replace(/"/g, "");
  const q = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql.replaceAll("$S", `"${schema}"`), params)).rows as T[];
  const failures: string[] = [];
  let checks = 0;
  const expect = (ok: boolean, message: string) => {
    checks += 1;
    if (!ok) failures.push(message);
  };
  const eq = (label: string, indexed: bigint | number | string | null, chain: bigint | number | string | null) =>
    expect(String(indexed) === String(chain), `${label}: indexed ${indexed}, chain ${chain}`);

  const coins = await q<CoinRow>(`SELECT * FROM $S.coin WHERE launched = true ORDER BY address`);
  const markets = await q<CoinRow & { supply_raw: string }>(`SELECT * FROM $S.market WHERE launched = true ORDER BY address, pool_id`);
  const authors = await q<{ coin: string; pool_id: string; quote: string; earned: string; claimed: string; reclaimed: string }>(`SELECT * FROM $S.author_ledger`);
  const tweets = await q<{ coin: string; post_id: string; author_x_user_id: string; author_share_bps: number; verify_by: number; verified_wallet: string | null }>(`SELECT * FROM $S.tweet_attribution`);
  for (const t of tweets) {
    const [postId, authorId, share, verifyBy, wallet] = await client.readContract({ address: d.feeVault, abi: tweetVaultReadAbi, functionName: "tweetAttribution", args: [getAddress(t.coin)] });
    eq(`tweet ${t.coin.slice(0, 10)} postId`, t.post_id, postId);
    eq(`tweet ${t.coin.slice(0, 10)} authorId`, t.author_x_user_id, authorId);
    eq(`tweet ${t.coin.slice(0, 10)} share`, t.author_share_bps, share);
    eq(`tweet ${t.coin.slice(0, 10)} treasuryUnlockAt (legacy verifyBy)`, t.verify_by, verifyBy);
    eq(`tweet ${t.coin.slice(0, 10)} wallet`, t.verified_wallet ?? zeroAddress, wallet.toLowerCase());
  }
  for (const a of authors) {
    const pending = BigInt(a.earned) - BigInt(a.claimed) - BigInt(a.reclaimed);
    expect(pending >= 0n, `author ${a.pool_id} negative liability`);
    eq(`author ${a.pool_id} pending`, pending, await client.readContract({ address: d.feeVault, abi: tweetVaultReadAbi,
      functionName: "authorPendingFor", args: [getAddress(a.coin), getAddress(a.quote)] }));
  }
  for (const c of coins) {
    const coin = getAddress(c.address);
    const tag = `${coin.slice(0, 10)}`;

    // Balances: every indexed balance equals balanceOf, and all of them sum to the supply.
    const balances = await q<{ account: string; amount: string; excluded: boolean }>(
      `SELECT account, amount, excluded FROM $S.balance WHERE coin = $1`,
      [c.address],
    );
    let sum = 0n;
    let holders = 0;
    for (const b of balances) {
      const chainBalance = await client.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(b.account)] });
      eq(`${tag} balance ${b.account.slice(0, 10)}`, b.amount, chainBalance);
      sum += BigInt(b.amount);
      if (!b.excluded && BigInt(b.amount) > 0n) holders += 1;
    }
    eq(`${tag} sum of balances`, sum, COIN_SUPPLY);
    eq(`${tag} holders`, c.holders, holders);
    eq(`${tag} burned`, c.burned, await client.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [DEAD_ADDRESS] }));
    eq(`${tag} pool coins`, c.pool_coins, await client.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [d.poolManager] }));
    const pairs = markets.filter((m) => m.address === c.address);
    eq(`${tag} market allocations`, pairs.reduce((sum, m) => sum + BigInt(m.supply_raw), 0n), COIN_SUPPLY);
    eq(`${tag} aggregate pool coins`, pairs.reduce((sum, m) => sum + BigInt(m.pool_coins), 0n), c.pool_coins);

    // Terms that can change after launch.
    const config = await client.readContract({ address: d.hook, abi: memeFunHookAbi, functionName: "configOf", args: [coin] });
    eq(`${tag} feeBps`, c.fee_bps, config.feeBps);
    eq(`${tag} creator`, c.creator, (await client.readContract({ address: d.hook, abi: memeFunHookAbi, functionName: "creatorOf", args: [coin] })).toLowerCase());

    // Candles: every interval accounts for every trade, and the latest close is the coin price.
    const candles = await q<{ interval: number; trades: string; volume: string; last_close: string }>(
      `SELECT interval, SUM(trades)::text AS trades, SUM(volume_usd_e_8)::text AS volume,
              (ARRAY_AGG(close_usd_e_18 ORDER BY bucket DESC))[1]::text AS last_close
         FROM $S.candle WHERE coin = $1 AND pool_id = $2 GROUP BY interval ORDER BY interval`,
      [c.address, aggregatePoolId(c.address)],
    );
    expect(candles.length === (c.trades > 0 ? 6 : 0), `${tag} candle intervals: ${candles.length}`);
    for (const candle of candles) {
      eq(`${tag} candles(${candle.interval}) trades`, candle.trades, c.trades);
      eq(`${tag} candles(${candle.interval}) volume`, candle.volume, c.volume_usd_e_8);
      eq(`${tag} candles(${candle.interval}) close`, candle.last_close, c.price_usd_e_18);
    }
  }

  for (const m of markets) {
    const coin = getAddress(m.address);
    const quote = getAddress(m.quote);
    const tag = `${coin.slice(0, 10)}/${quote.slice(0, 8)}`;
    const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [m.pool_id, POOLS_SLOT]));
    const slot0 = await client.readContract({ address: d.poolManager, abi: extsloadAbi, functionName: "extsload", args: [slot] });
    eq(`${tag} sqrtPriceX96`, m.sqrt_price_x_96, hexToBigInt(slot0) & ((1n << 160n) - 1n));
    const config = await client.readContract({ address: d.hook, abi: memeFunHookAbi, functionName: "configFor", args: [coin, quote] });
    eq(`${tag} feeBps`, m.fee_bps, config.feeBps);
    eq(`${tag} creator pending`, BigInt(m.creator_earned) - BigInt(m.creator_claimed),
      await client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "creatorPendingFor", args: [coin, quote] }));
    eq(`${tag} destination pending`, BigInt(m.destination_earned) - BigInt(m.destination_pulled),
      await client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "destinationPendingFor", args: [coin, quote] }));
    if (m.mode === 1) {
      eq(`${tag} buyback spent`, m.buyback_spent, await client.readContract({ address: d.buybackBurnVault, abi: buybackBurnVaultAbi, functionName: "totalSpentFor", args: [coin, quote] }));
      eq(`${tag} buyback burned`, m.buyback_burned, await client.readContract({ address: d.buybackBurnVault, abi: buybackBurnVaultAbi, functionName: "totalBurnedFor", args: [coin, quote] }));
    }
    if (m.mode === 3) {
      eq(`${tag} floor quote`, m.floor_quote, await client.readContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "totalFlooredFor", args: [coin, quote] }));
      const hasFloor = await client.readContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "hasFloorFor", args: [coin, quote] });
      const near = hasFloor ? await client.readContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "floorNearTickFor", args: [coin, quote] }) : null;
      eq(`${tag} floor near tick`, m.floor_near_tick, near);
    }
    const candles = await q<{ interval: number; trades: string; volume: string; last_close: string }>(
      `SELECT interval, SUM(trades)::text AS trades, SUM(volume_quote)::text AS volume,
        (ARRAY_AGG(close_usd_e_18 ORDER BY bucket DESC))[1]::text AS last_close
       FROM $S.candle WHERE pool_id = $1 GROUP BY interval`, [m.pool_id]);
    expect(candles.length === (m.trades > 0 ? 6 : 0), `${tag} candle intervals`);
    for (const candle of candles) {
      eq(`${tag} candles(${candle.interval}) trades`, candle.trades, m.trades);
      eq(`${tag} candles(${candle.interval}) volume`, candle.volume, m.volume_quote);
      eq(`${tag} candles(${candle.interval}) close`, candle.last_close, m.price_usd_e_18);
    }
  }

  // Referral and platform ledgers.
  const referrals = await q<{ referrer: string; currency: string; earned: string; claimed: string }>(`SELECT * FROM $S.referral_ledger`);
  for (const r of referrals) {
    const pending = await client.readContract({
      address: d.feeVault,
      abi: feeVaultAbi,
      functionName: "referralPending",
      args: [getAddress(r.referrer), getAddress(r.currency)],
    });
    eq(`referral ${r.referrer.slice(0, 10)}/${r.currency.slice(0, 8)}`, BigInt(r.earned) - BigInt(r.claimed), pending);
  }
  const platform = await q<{ currency: string; earned: string; claimed: string }>(`SELECT * FROM $S.platform_ledger`);
  for (const p of platform) {
    const pending = await client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "platformPending", args: [getAddress(p.currency)] });
    eq(`platform ${p.currency.slice(0, 8)}`, BigInt(p.earned) - BigInt(p.claimed), pending);
  }

  // Conservation per pair asset: what the PoolManager holds equals the indexed pool quote of every
  // coin on that asset plus every ERC-6909 claim on it (fee ledgers and module balances).
  const perQuote = await q<{ quote: string; pool_quote: string }>(
    `SELECT quote, SUM(pool_quote)::text AS pool_quote FROM $S.market WHERE launched = true GROUP BY quote`,
  );
  const claimHolders = [d.feeVault, d.buybackBurnVault, d.floorVault, d.holderRewardDistributor];
  for (const row of perQuote) {
    const currency = getAddress(row.quote);
    const held =
      currency === zeroAddress
        ? await client.getBalance({ address: d.poolManager })
        : await client.readContract({ address: currency, abi: erc20Abi, functionName: "balanceOf", args: [d.poolManager] });
    let claims = 0n;
    for (const holder of claimHolders) {
      const heldClaims = await client.readContract({ address: d.poolManager, abi: erc6909BalanceAbi, functionName: "balanceOf", args: [holder as Address, BigInt(currency)] });
      claims += heldClaims;
      if (holder === d.feeVault) {
        const rawPending = (earned: string, claimed: string) => BigInt(earned) - BigInt(claimed);
        const vaultLiability = markets.filter(m => m.quote === row.quote).reduce((sum, m) => sum
          + rawPending(m.creator_earned, m.creator_claimed) + rawPending(m.destination_earned, m.destination_pulled), 0n)
          + platform.filter(p => p.currency === row.quote).reduce((sum, p) => sum + rawPending(p.earned, p.claimed), 0n)
          + referrals.filter(r => r.currency === row.quote).reduce((sum, r) => sum + rawPending(r.earned, r.claimed), 0n)
          + authors.filter(a => a.quote === row.quote).reduce((sum, a) => sum + BigInt(a.earned) - BigInt(a.claimed) - BigInt(a.reclaimed), 0n);
        eq(`vault liability ${row.quote.slice(0, 8)} (includes author reserves)`, vaultLiability, heldClaims);
      }
    }
    eq(`conservation ${row.quote.slice(0, 8)} (pool quote + claims = PoolManager balance)`, BigInt(row.pool_quote) + claims, held);
  }

  // Holder-reward epochs, if any were published.
  const lastEpoch = await client.readContract({ address: d.holderRewardDistributor, abi: holderRewardDistributorAbi, functionName: "lastEpoch" });
  const indexedEpochs = await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM $S.epoch`);
  eq("epochs published", indexedEpochs[0]?.n ?? "0", lastEpoch);

  return { coins: coins.length, checks, failures };
}
