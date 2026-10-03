import { ponder } from "ponder:registry";
import { activity, coin, quote, quotePrice, trade } from "ponder:schema";

import { lc } from "../lib/indexer/addresses";
import { addresses } from "../lib/indexer/runtime";
import { marketCapUsdE8, priceUsdE18 } from "../lib/market/math";
import { resolveQuote } from "../lib/market/pool";
import { getSqrtPriceAtTick } from "../shared/core/uniswap/tickMath";
import { applyTrade } from "./_apply";

/**
 * A launch transaction emits, in order: PoolRegistered (hook), the coin's transfers, the first
 * buy's Trade (if any) and finally Launched (factory). The coin row is created here with the terms
 * the hook froze, then completed by Launched, which also applies the parked first buy.
 */
ponder.on("MemeFunHook:PoolRegistered", async ({ event, context }) => {
  const { id, coin: coinAddress, creator, config } = event.args;
  const quotes = await context.db.sql.select({ address: quote.address }).from(quote);
  const quoteAddress = resolveQuote(id, coinAddress, addresses.hook, quotes.map((q) => q.address));
  if (!quoteAddress) {
    throw new Error(`PoolRegistered for ${coinAddress}: pool ${id} matches no listed quote`);
  }

  await context.db.insert(coin).values({
    address: lc(coinAddress),
    poolId: id,
    creator: lc(creator),
    launcher: lc(creator),
    quote: lc(quoteAddress),
    quoteIsCurrency0: config.quoteIsCurrency0,
    mode: config.mode,
    module: lc(config.module),
    feeBps: config.feeBps,
    launchFeeBps: config.feeBps,
    platformShareBps: config.platformShareBps,
    referralShareBps: config.referralShareBps,
    creatorKeepBps: config.creatorKeepBps,
    protectionStartBps: config.protectionStartBps,
    protectionDurationSec: config.protectionDurationSec,
    createdAt: Number(event.block.timestamp),
    createdBlock: event.block.number,

    launched: false,
    name: "",
    symbol: "",
    contractUri: "",
    startTick: 0,
    liquidity: 0n,
    launchQuoteUsdE8: 0n,
    openingFdvUsdE8: 0n,
    launchTx: null,
    pendingFirstBuy: null,

    sqrtPriceX96: 0n,
    tick: 0,
    poolQuote: 0n,
    poolCoins: 0n,
    burned: 0n,

    priceUsdE18: 0n,
    marketCapUsdE8: 0n,
    athMarketCapUsdE8: 0n,
    volumeQuote: 0n,
    volumeUsdE8: 0n,
    trades: 0,
    buys: 0,
    sells: 0,
    lastTradeAt: Number(event.block.timestamp),
    holders: 0,

    feesTotal: 0n,
    platformFees: 0n,
    referralFees: 0n,
    creatorEarned: 0n,
    creatorClaimed: 0n,
    destinationEarned: 0n,
    destinationPulled: 0n,

    buybacks: 0,
    buybackSpent: 0n,
    buybackBurned: 0n,
    floorAdds: 0,
    floorQuote: 0n,
    floorNearTick: null,
    holdersReserved: 0n,
    holdersClaimed: 0n,
    holdersReturned: 0n,
    epochs: 0,

    devSold: false,
    snipers: 0,
    sameBlockBuys: 0,
  });
});

ponder.on("MemeFunFactory:Launched", async ({ event, context }) => {
  const { coin: coinAddress, quote: quoteAddress, name, symbol, contractURI, record } = event.args;
  const db = context.db;
  const address = lc(coinAddress);
  const existing = await db.find(coin, { address });
  if (!existing) throw new Error(`Launched for ${address} without PoolRegistered`);
  if (lc(existing.quote) !== lc(quoteAddress)) {
    throw new Error(`Launched for ${address}: quote ${quoteAddress} differs from the registered pool's ${existing.quote}`);
  }
  const q = await db.find(quote, { address: lc(quoteAddress) });
  if (!q) throw new Error(`Launched for ${address}: quote ${quoteAddress} is not listed`);

  // The exact price the pool opened at, valued with the quote price the factory used.
  const timestamp = Number(event.block.timestamp);
  const sqrtPriceX96 = getSqrtPriceAtTick(record.startTick);
  const openingPrice = priceUsdE18(sqrtPriceX96, { quoteIsCurrency0: existing.quoteIsCurrency0, quoteDecimals: q.decimals }, record.quoteUsdE8);
  const openingMarketCap = marketCapUsdE8(openingPrice, existing.burned);
  const launchedCoin = await db.update(coin, { address }).set({
    launched: true,
    name,
    symbol,
    contractUri: contractURI,
    startTick: record.startTick,
    liquidity: record.liquidity,
    launchQuoteUsdE8: record.quoteUsdE8,
    openingFdvUsdE8: record.openingFdvUsdE8,
    launchTx: event.transaction.hash,
    sqrtPriceX96,
    tick: record.startTick,
    priceUsdE18: openingPrice,
    marketCapUsdE8: openingMarketCap,
    athMarketCapUsdE8: openingMarketCap,
  });

  // The factory priced the launch with this quote price: the freshest one available.
  if (record.quoteUsdE8 > 0n && timestamp >= q.priceUpdatedAt) {
    await db.update(quote, { address: lc(quoteAddress) }).set({ priceUsdE8: record.quoteUsdE8, priceUpdatedAt: timestamp });
    await db
      .insert(quotePrice)
      .values({
        id: `${lc(quoteAddress)}-${event.block.number}-launch`,
        quote: lc(quoteAddress),
        priceUsdE8: record.quoteUsdE8,
        source: "launch",
        blockNumber: event.block.number,
        timestamp,
      })
      .onConflictDoNothing();
  }

  if (launchedCoin.pendingFirstBuy) {
    const parked = await db.find(trade, { id: launchedCoin.pendingFirstBuy });
    if (!parked) throw new Error(`Launched for ${address}: parked first buy ${launchedCoin.pendingFirstBuy} not found`);
    await applyTrade(
      context,
      launchedCoin,
      q,
      {
        id: parked.id,
        kind: "first_buy",
        trader: lc(parked.trader),
        sender: lc(parked.sender),
        isBuy: parked.isBuy,
        quoteAmount: parked.quoteAmount,
        coinAmount: parked.coinAmount,
        fee: parked.fee,
        feeBps: parked.feeBps,
        referrer: parked.referrer ? lc(parked.referrer) : null,
        sqrtPriceX96: parked.sqrtPriceX96,
        tick: parked.tick,
        blockNumber: parked.blockNumber,
        logIndex: parked.logIndex,
        timestamp: parked.timestamp,
        txHash: parked.txHash,
      },
      record.quoteUsdE8,
      { existingRow: true },
    );
    await db.update(coin, { address }).set({ pendingFirstBuy: null });
  }

  await db.insert(activity).values({
    id: `launch-${address}`,
    kind: "launch",
    coin: address,
    amountQuote: record.firstBuyQuote,
    amountCoins: record.firstBuyCoins,
    milestoneUsd: null,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp,
    txHash: event.transaction.hash,
  });
});
