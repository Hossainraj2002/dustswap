import { type Context, ponder } from "ponder:registry";
import { balance, coin, transfer } from "ponder:schema";

import { DEAD, type Lower, ZERO, isExcludedHolder, lc } from "../lib/indexer/addresses";
import { addresses } from "../lib/indexer/runtime";

/**
 * Coin transfers drive balances, the holder count, burns, the launch position's deposit and the
 * dev-sold signal. The mint (zero address to the factory) comes before the coin's PoolRegistered
 * in the launch transaction, so a transfer may arrive for a coin with no row yet; only the
 * factory is involved then, and it never counts as a holder.
 */
ponder.on("Coin:Transfer", async ({ event, context }) => {
  const coinAddress = lc(event.log.address);
  const from = lc(event.args.from);
  const to = lc(event.args.to);
  const amount = event.args.amount;
  const timestamp = Number(event.block.timestamp);

  await context.db.insert(transfer).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    coin: coinAddress,
    from,
    to,
    amount,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp,
    txHash: event.transaction.hash,
  });
  if (amount === 0n || from === to) return;

  let holderDelta = 0;
  if (from !== ZERO) holderDelta += await moveBalance(context, coinAddress, from, -amount, timestamp);
  if (to !== ZERO) holderDelta += await moveBalance(context, coinAddress, to, amount, timestamp);

  const c = await context.db.find(coin, { address: coinAddress });
  if (!c) {
    if (holderDelta !== 0 || to === DEAD || to === addresses.poolManager) {
      throw new Error(`Transfer on ${coinAddress} before its PoolRegistered moves counted coins (${from} -> ${to})`);
    }
    return;
  }
  const deposit = from === addresses.factory && to === addresses.poolManager ? amount : 0n;
  const burnt = to === DEAD ? amount : 0n;
  const devSold = from === lc(c.launcher) && to === addresses.poolManager;
  if (holderDelta === 0 && deposit === 0n && burnt === 0n && !devSold) return;
  await context.db.update(coin, { address: coinAddress }).set((current) => ({
    holders: current.holders + holderDelta,
    poolCoins: current.poolCoins + deposit,
    burned: current.burned + burnt,
    devSold: current.devSold || devSold,
  }));
});

/** Applies a balance change; returns +1 / -1 when a counted holder appears or leaves, else 0. */
async function moveBalance(context: Context, coinAddress: Lower, account: Lower, delta: bigint, timestamp: number): Promise<number> {
  const key = { coin: coinAddress, account };
  const row = await context.db.find(balance, key);
  const before = row?.amount ?? 0n;
  const after = before + delta;
  if (after < 0n) {
    throw new Error(`Balance of ${account} in ${coinAddress} would go negative (${before} + ${delta}); a transfer was missed`);
  }
  const excluded = isExcludedHolder(addresses, coinAddress, account);
  if (row) {
    await context.db.update(balance, key).set({
      amount: after,
      firstHeldAt: row.firstHeldAt ?? (after > 0n ? timestamp : null),
      updatedAt: timestamp,
    });
  } else {
    await context.db.insert(balance).values({
      ...key,
      amount: after,
      excluded,
      boughtCoins: 0n,
      boughtUsdE8: 0n,
      soldCoins: 0n,
      soldUsdE8: 0n,
      firstHeldAt: after > 0n ? timestamp : null,
      updatedAt: timestamp,
    });
  }
  if (excluded) return 0;
  if (before === 0n && after > 0n) return 1;
  if (before > 0n && after === 0n) return -1;
  return 0;
}
