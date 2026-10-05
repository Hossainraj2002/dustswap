import { type Context, ponder } from "ponder:registry";
import { activity, buyback, coin, epoch, epochCoin, floorAdd, holderClaim, market } from "ponder:schema";
import type { Hex } from "viem";

import { lc } from "../lib/indexer/addresses";
import { epochReleaseAccounting } from "../lib/indexer/epoch-release";
import { epochClaimAccounting } from "../lib/indexer/epoch-claim";

type EventPosition = { transaction: { hash: Hex }; log: { logIndex: number }; block: { number: bigint; timestamp: bigint } };
type MarketRow = typeof market.$inferSelect;

async function primaryMarket(context: Context, address: string) {
  const c = await context.db.find(coin, { address: lc(address) });
  if (!c) throw new Error(`Unknown coin ${address}`);
  const m = await context.db.find(market, { poolId: c.poolId });
  if (!m) throw new Error(`Unknown primary market ${c.poolId}`);
  return m;
}

async function mirrorPrimary(context: Context, m: MarketRow, update: (row: typeof coin.$inferSelect) => Partial<typeof coin.$inferSelect>) {
  const c = await context.db.find(coin, { address: lc(m.address) });
  if (c?.poolId === m.poolId) await context.db.update(coin, { address: lc(m.address) }).set(update);
}

async function recordBuyback(context: Context, event: EventPosition, m: MarketRow, args: { quoteSpent: bigint; coinsBurned: bigint; quoteLeft: bigint }) {
  const id = `${event.transaction.hash}-${event.log.logIndex}`;
  const timestamp = Number(event.block.timestamp);
  await context.db.insert(buyback).values({ id, coin: lc(m.address), poolId: m.poolId, quote: lc(m.quote), ...args,
    blockNumber: event.block.number, timestamp, txHash: event.transaction.hash });
  await context.db.update(market, { poolId: m.poolId }).set((row) => ({ buybacks: row.buybacks + 1,
    buybackSpent: row.buybackSpent + args.quoteSpent, buybackBurned: row.buybackBurned + args.coinsBurned }));
  await context.db.update(coin, { address: lc(m.address) }).set((row) => ({ buybacks: row.buybacks + 1,
    buybackBurned: row.buybackBurned + args.coinsBurned,
    ...(row.poolId === m.poolId ? { buybackSpent: row.buybackSpent + args.quoteSpent } : {}) }));
  await context.db.insert(activity).values({ id: `burn-${id}`, kind: "burn", coin: lc(m.address), poolId: m.poolId,
    currency: lc(m.quote), amountQuote: args.quoteSpent, amountCoins: args.coinsBurned, milestoneUsd: null,
    blockNumber: event.block.number, logIndex: event.log.logIndex, timestamp, txHash: event.transaction.hash });
}

ponder.on("BuybackBurnVault:MarketBuyback", async ({ event, context }) => {
  const m = await context.db.find(market, { poolId: event.args.poolId });
  if (!m) throw new Error(`Unknown buyback market ${event.args.poolId}`);
  await recordBuyback(context, event, m, event.args);
});
ponder.on("BuybackBurnVault:Buyback", async ({ event, context }) => {
  const m = await primaryMarket(context, event.args.coin);
  if (!m.hasMarketEvents) await recordBuyback(context, event, m, event.args);
});

async function recordFloor(context: Context, event: EventPosition, m: MarketRow, args: { tickLower: number; tickUpper: number; liquidity: bigint; quoteUsed: bigint }) {
  const id = `${event.transaction.hash}-${event.log.logIndex}`;
  const timestamp = Number(event.block.timestamp);
  await context.db.insert(floorAdd).values({ id, coin: lc(m.address), poolId: m.poolId, quote: lc(m.quote), ...args,
    blockNumber: event.block.number, timestamp, txHash: event.transaction.hash });
  const update = (row: typeof coin.$inferSelect) => {
    const near = row.quoteIsCurrency0 ? args.tickLower : args.tickUpper;
    const current = row.floorNearTick;
    const pricier = current === null || (row.quoteIsCurrency0 ? near < current : near > current);
    return { floorAdds: row.floorAdds + 1, floorQuote: row.floorQuote + args.quoteUsed,
      poolQuote: row.poolQuote + args.quoteUsed, floorNearTick: pricier ? near : current };
  };
  await context.db.update(market, { poolId: m.poolId }).set(update);
  await mirrorPrimary(context, m, update);
  await context.db.insert(activity).values({ id: `floor-${id}`, kind: "floor", coin: lc(m.address), poolId: m.poolId,
    currency: lc(m.quote), amountQuote: args.quoteUsed, amountCoins: null, milestoneUsd: null,
    blockNumber: event.block.number, logIndex: event.log.logIndex, timestamp, txHash: event.transaction.hash });
}
ponder.on("FloorVault:MarketFloorAdded", async ({ event, context }) => {
  const m = await context.db.find(market, { poolId: event.args.poolId });
  if (!m) throw new Error(`Unknown floor market ${event.args.poolId}`);
  await recordFloor(context, event, m, event.args);
});
ponder.on("FloorVault:FloorAdded", async ({ event, context }) => {
  const m = await primaryMarket(context, event.args.coin);
  if (!m.hasMarketEvents) await recordFloor(context, event, m, event.args);
});

async function recordEpoch(context: Context, event: EventPosition, epochNumber: bigint, root: Hex, pools: readonly Hex[], totals: readonly bigint[]) {
  await context.db.insert(epoch).values({ epoch: epochNumber, root, publishedAt: Number(event.block.timestamp), vetoed: false,
    coins: pools.length, blockNumber: event.block.number, txHash: event.transaction.hash });
  const seenCoins = new Set<string>();
  for (let i = 0; i < pools.length; i += 1) {
    const m = await context.db.find(market, { poolId: pools[i]! });
    if (!m) throw new Error(`Unknown epoch market ${pools[i]}`);
    const total = totals[i]!;
    await context.db.insert(epochCoin).values({ epoch: epochNumber, coin: lc(m.address), poolId: m.poolId, quote: lc(m.quote),
      total, claimed: 0n, claims: 0, released: false, returned: 0n });
    await context.db.update(market, { poolId: m.poolId }).set((row) => ({ holdersReserved: row.holdersReserved + total, epochs: row.epochs + 1 }));
    await mirrorPrimary(context, m, (row) => ({ holdersReserved: row.holdersReserved + total }));
    if (!seenCoins.has(m.address)) {
      await context.db.update(coin, { address: lc(m.address) }).set((row) => ({ epochs: row.epochs + 1 }));
      seenCoins.add(m.address);
    }
    await context.db.insert(activity).values({ id: `payout-${epochNumber}-${m.poolId}`, kind: "payout", coin: lc(m.address), poolId: m.poolId,
      currency: lc(m.quote), amountQuote: total, amountCoins: null, milestoneUsd: null, blockNumber: event.block.number,
      logIndex: event.log.logIndex, timestamp: Number(event.block.timestamp), txHash: event.transaction.hash });
  }
}
ponder.on("HolderRewardDistributor:MarketEpochPublished", async ({ event, context }) => {
  await recordEpoch(context, event, event.args.epoch, event.args.root, event.args.poolIds, event.args.totals);
});
ponder.on("HolderRewardDistributor:EpochPublished", async ({ event, context }) => {
  const pools = await Promise.all(event.args.coins.map(async (address) => (await primaryMarket(context, address)).poolId));
  await recordEpoch(context, event, event.args.epoch, event.args.root, pools, event.args.totals);
});
ponder.on("HolderRewardDistributor:EpochVetoed", async ({ event, context }) => {
  await context.db.update(epoch, { epoch: event.args.epoch }).set({ vetoed: true });
});

async function recordRelease(context: Context, epochNumber: bigint, poolId: Hex, returned: bigint) {
  const key = { epoch: epochNumber, poolId };
  const accounting = epochReleaseAccounting(await context.db.find(epochCoin, key), returned);
  if (!accounting) return;
  const m = await context.db.find(market, { poolId });
  if (!m) throw new Error(`Unknown release market ${poolId}`);
  await context.db.update(epochCoin, key).set(accounting);
  await context.db.update(market, { poolId }).set((row) => ({ holdersReturned: row.holdersReturned + returned }));
  await mirrorPrimary(context, m, (row) => ({ holdersReturned: row.holdersReturned + returned }));
}
ponder.on("HolderRewardDistributor:MarketEpochReleased", async ({ event, context }) => {
  await recordRelease(context, event.args.epoch, event.args.poolId, event.args.returned);
});
ponder.on("HolderRewardDistributor:EpochReleased", async ({ event, context }) => {
  await recordRelease(context, event.args.epoch, (await primaryMarket(context, event.args.coin)).poolId, event.args.returned);
});

async function recordClaim(context: Context, event: EventPosition, poolId: Hex, args: { epoch: bigint; index: bigint; account: Hex; amount: bigint }) {
  const m = await context.db.find(market, { poolId });
  if (!m) throw new Error(`Unknown claim market ${poolId}`);
  const key = { epoch: args.epoch, poolId };
  const accounting = epochClaimAccounting(await context.db.find(epochCoin, key), args.amount);
  // A zero claim still sets an on-chain bitmap bit, even if a bad publisher root omitted its pot.
  await context.db.insert(holderClaim).values({ id: `${event.transaction.hash}-${event.log.logIndex}`, epoch: args.epoch,
    coin: lc(m.address), poolId, quote: lc(m.quote), index: args.index, account: lc(args.account), amount: args.amount,
    timestamp: Number(event.block.timestamp), txHash: event.transaction.hash });
  if (!accounting) return;
  await context.db.update(epochCoin, key).set(accounting);
  await context.db.update(market, { poolId }).set((row) => ({ holdersClaimed: row.holdersClaimed + args.amount }));
  await mirrorPrimary(context, m, (row) => ({ holdersClaimed: row.holdersClaimed + args.amount }));
}
ponder.on("HolderRewardDistributor:MarketClaimed", async ({ event, context }) => {
  await recordClaim(context, event, event.args.poolId, event.args);
});
ponder.on("HolderRewardDistributor:Claimed", async ({ event, context }) => {
  await recordClaim(context, event, (await primaryMarket(context, event.args.coin)).poolId, event.args);
});
