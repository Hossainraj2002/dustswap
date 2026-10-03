import { ponder } from "ponder:registry";
import { activity, buyback, coin, epoch, epochCoin, floorAdd, holderClaim } from "ponder:schema";

import { lc } from "../lib/indexer/addresses";

// ------------------------------------------------------------------------- buyback and burn

ponder.on("BuybackBurnVault:Buyback", async ({ event, context }) => {
  const { coin: coinAddress, quoteSpent, coinsBurned, quoteLeft } = event.args;
  const id = `${event.transaction.hash}-${event.log.logIndex}`;
  const timestamp = Number(event.block.timestamp);
  await context.db.insert(buyback).values({
    id,
    coin: lc(coinAddress),
    quoteSpent,
    coinsBurned,
    quoteLeft,
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });
  await context.db.update(coin, { address: lc(coinAddress) }).set((c) => ({
    buybacks: c.buybacks + 1,
    buybackSpent: c.buybackSpent + quoteSpent,
    buybackBurned: c.buybackBurned + coinsBurned,
  }));
  await context.db.insert(activity).values({
    id: `burn-${id}`,
    kind: "burn",
    coin: lc(coinAddress),
    amountQuote: quoteSpent,
    amountCoins: coinsBurned,
    milestoneUsd: null,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp,
    txHash: event.transaction.hash,
  });
});

// ------------------------------------------------------------------------- liquidity floor

ponder.on("FloorVault:FloorAdded", async ({ event, context }) => {
  const { coin: coinAddress, tickLower, tickUpper, liquidity, quoteUsed } = event.args;
  const id = `${event.transaction.hash}-${event.log.logIndex}`;
  const timestamp = Number(event.block.timestamp);
  await context.db.insert(floorAdd).values({
    id,
    coin: lc(coinAddress),
    tickLower,
    tickUpper,
    liquidity,
    quoteUsed,
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });
  await context.db.update(coin, { address: lc(coinAddress) }).set((c) => {
    // The band's edge nearest the price is the coin price the floor supports; keep the pricier one,
    // exactly as FloorVault.floorNearTick does.
    const near = c.quoteIsCurrency0 ? tickLower : tickUpper;
    const current = c.floorNearTick;
    const pricier = current === null || (c.quoteIsCurrency0 ? near < current : near > current);
    return {
      floorAdds: c.floorAdds + 1,
      floorQuote: c.floorQuote + quoteUsed,
      poolQuote: c.poolQuote + quoteUsed,
      floorNearTick: pricier ? near : current,
    };
  });
  await context.db.insert(activity).values({
    id: `floor-${id}`,
    kind: "floor",
    coin: lc(coinAddress),
    amountQuote: quoteUsed,
    amountCoins: null,
    milestoneUsd: null,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp,
    txHash: event.transaction.hash,
  });
});

// ------------------------------------------------------------------------- holder rewards

ponder.on("HolderRewardDistributor:EpochPublished", async ({ event, context }) => {
  const { epoch: epochNumber, root, coins, totals } = event.args;
  const timestamp = Number(event.block.timestamp);
  await context.db.insert(epoch).values({
    epoch: epochNumber,
    root,
    publishedAt: timestamp,
    vetoed: false,
    coins: coins.length,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });
  for (let i = 0; i < coins.length; i += 1) {
    const coinAddress = lc(coins[i]!);
    const total = totals[i]!;
    await context.db.insert(epochCoin).values({
      epoch: epochNumber,
      coin: coinAddress,
      total,
      claimed: 0n,
      claims: 0,
      released: false,
      returned: 0n,
    });
    await context.db.update(coin, { address: coinAddress }).set((c) => ({
      holdersReserved: c.holdersReserved + total,
      epochs: c.epochs + 1,
    }));
    await context.db.insert(activity).values({
      id: `payout-${epochNumber}-${coinAddress}`,
      kind: "payout",
      coin: coinAddress,
      amountQuote: total,
      amountCoins: null,
      milestoneUsd: null,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp,
      txHash: event.transaction.hash,
    });
  }
});

ponder.on("HolderRewardDistributor:EpochVetoed", async ({ event, context }) => {
  await context.db.update(epoch, { epoch: event.args.epoch }).set({ vetoed: true });
});

ponder.on("HolderRewardDistributor:EpochReleased", async ({ event, context }) => {
  const { epoch: epochNumber, coin: coinAddress, returned } = event.args;
  await context.db
    .update(epochCoin, { epoch: epochNumber, coin: lc(coinAddress) })
    .set({ released: true, returned });
  await context.db.update(coin, { address: lc(coinAddress) }).set((c) => ({ holdersReturned: c.holdersReturned + returned }));
});

ponder.on("HolderRewardDistributor:Claimed", async ({ event, context }) => {
  const { epoch: epochNumber, coin: coinAddress, index, account, amount } = event.args;
  await context.db.insert(holderClaim).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    epoch: epochNumber,
    coin: lc(coinAddress),
    index,
    account: lc(account),
    amount,
    timestamp: Number(event.block.timestamp),
    txHash: event.transaction.hash,
  });
  await context.db
    .update(epochCoin, { epoch: epochNumber, coin: lc(coinAddress) })
    .set((row) => ({ claimed: row.claimed + amount, claims: row.claims + 1 }));
  await context.db.update(coin, { address: lc(coinAddress) }).set((c) => ({ holdersClaimed: c.holdersClaimed + amount }));
});
