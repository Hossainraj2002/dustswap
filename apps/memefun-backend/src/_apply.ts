import type { Context } from "ponder:registry";
import { eq } from "ponder";
import {
  activity,
  authorLedger,
  balance,
  candle,
  coin,
  launchBlock,
  launchBlockBuyer,
  milestone,
  market,
  platformLedger,
  quote,
  referralLedger,
  sniper,
  trade,
  tweetAttribution,
} from "ponder:schema";

import { type Lower, type TradeKind, isExcludedHolder, lc } from "../lib/indexer/addresses";
import {
  CANDLE_INTERVALS,
  type CandleRow,
  SAME_BLOCK_WINDOW_SEC,
  bucketStart,
  foldCandle,
  sameBlockIncrement,
  tradeEffects,
  crossedMilestones,
} from "../lib/indexer/effects";
import { addresses } from "../lib/indexer/runtime";
import { aggregatePoolId, weightedMarketPrice } from "../lib/market/derive";
import { marketCapUsdE8, priceUsdE18 } from "../lib/market/math";
import { tweetCreatorSplit } from "../lib/indexer/tweet-fees";

/**
 * Shared by the Trade handler and the Launched handler (which applies a coin's first buy once the
 * coin is complete). Not an indexing file: it registers nothing.
 */
export type CoinRow = typeof coin.$inferSelect;
export type MarketRow = typeof market.$inferSelect;
export type QuoteRow = typeof quote.$inferSelect;
export type TradeRow = typeof trade.$inferSelect;

const max = (a: bigint, b: bigint) => (a > b ? a : b);

export interface RawTrade {
  id: string;
  kind: TradeKind;
  trader: Lower;
  sender: Lower;
  isBuy: boolean;
  /** As emitted by the hook. */
  quoteAmount: bigint;
  coinAmount: bigint;
  fee: bigint;
  feeBps: number;
  referrer: Lower | null;
  sqrtPriceX96: bigint;
  tick: number;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
  txHash: `0x${string}`;
}

/** Writes the trade (insert, or update of a parked first buy) and everything it changes. */
export async function applyTrade(
  context: Context,
  c: CoinRow,
  m: MarketRow,
  q: QuoteRow,
  t: RawTrade,
  quoteUsdE8: bigint,
  options: { existingRow: boolean },
) {
  const db = context.db;
  const e = tradeEffects(m, { burned: c.burned, priceUsdE18: m.priceUsdE18 }, { decimals: q.decimals, priceUsdE8: quoteUsdE8 }, t);
  const attribution = await db.find(tweetAttribution, { coin: lc(c.address) });
  const creatorSplit = tweetCreatorSplit(e.split.creator, attribution);
  const platformFees = e.split.platform;
  const isCreator = t.trader === lc(c.creator) || t.trader === lc(c.launcher);

  const row = {
    coin: lc(c.address),
    poolId: m.poolId,
    quote: lc(m.quote),
    trader: t.trader,
    sender: t.sender,
    isBuy: t.isBuy,
    kind: t.kind,
    quoteAmount: e.quoteAmount,
    poolQuoteDelta: e.poolQuoteDelta,
    coinAmount: t.coinAmount,
    fee: t.fee,
    feeBps: t.feeBps,
    referrer: t.referrer,
    sqrtPriceX96: t.sqrtPriceX96,
    tick: t.tick,
    quoteUsdE8,
    valueUsdE8: e.valueUsdE8,
    priceUsdE18: e.priceUsdE18,
    marketCapUsdE8: e.marketCapUsdE8,
    inProtection: e.inProtection,
    isCreator,
    blockNumber: t.blockNumber,
    logIndex: t.logIndex,
    timestamp: t.timestamp,
    txHash: t.txHash,
  };
  if (options.existingRow) await db.update(trade, { id: t.id }).set(row);
  else await db.insert(trade).values({ id: t.id, ...row });

  // Launch-fairness signals: wallets buying inside protection, and buyers sharing a block early on.
  let sniperInc = 0;
  let sameBlockInc = 0;
  if (t.isBuy && t.kind === "trade" && !isCreator) {
    if (e.inProtection) {
      const inserted = await db
        .insert(sniper)
        .values({ coin: lc(c.address), trader: t.trader, blockNumber: t.blockNumber })
        .onConflictDoNothing();
      if (inserted) sniperInc = 1;
    }
    if (t.timestamp - c.createdAt < SAME_BLOCK_WINDOW_SEC) {
      const newBuyer = await db
        .insert(launchBlockBuyer)
        .values({ coin: lc(c.address), blockNumber: t.blockNumber, trader: t.trader })
        .onConflictDoNothing();
      if (newBuyer) {
        const block = await db
          .insert(launchBlock)
          .values({ coin: lc(c.address), blockNumber: t.blockNumber, buyers: 1 })
          .onConflictDoUpdate((existing) => ({ buyers: existing.buyers + 1 }));
        sameBlockInc = sameBlockIncrement(block.buyers);
      }
    }
  }

  await db.update(market, { poolId: m.poolId }).set((current) => ({
    sqrtPriceX96: t.sqrtPriceX96,
    tick: t.tick,
    priceUsdE18: e.priceUsdE18,
    marketCapUsdE8: e.marketCapUsdE8,
    athMarketCapUsdE8: max(current.athMarketCapUsdE8, e.marketCapUsdE8),
    poolQuote: current.poolQuote + e.poolQuoteDelta,
    poolCoins: current.poolCoins + e.poolCoinDelta,
    volumeQuote: current.volumeQuote + e.quoteAmount,
    volumeUsdE8: current.volumeUsdE8 + e.valueUsdE8,
    trades: current.trades + 1,
    buys: current.buys + (t.isBuy ? 1 : 0),
    sells: current.sells + (t.isBuy ? 0 : 1),
    lastTradeAt: t.timestamp,
    feesTotal: current.feesTotal + t.fee,
    platformFees: current.platformFees + platformFees,
    referralFees: current.referralFees + e.split.referral,
    creatorEarned: current.creatorEarned + creatorSplit.launcher,
    destinationEarned: current.destinationEarned + e.split.destination,
  }));

  const pools = await db.sql.select({ poolId: market.poolId, poolCoins: market.poolCoins, sqrtPriceX96: market.sqrtPriceX96,
    quoteIsCurrency0: market.quoteIsCurrency0, quoteDecimals: quote.decimals, quoteUsdE8: quote.priceUsdE8,
  }).from(market).innerJoin(quote, eq(market.quote, quote.address)).where(eq(market.address, lc(c.address)));
  const valuedPools = pools.map((p) => ({ ...p, priceUsdE18: priceUsdE18(p.sqrtPriceX96,
    { quoteIsCurrency0: p.quoteIsCurrency0, quoteDecimals: p.quoteDecimals }, p.quoteUsdE8) }));
  const aggregatePrice = weightedMarketPrice(valuedPools, valuedPools.find((p) => p.poolId === c.poolId)?.priceUsdE18 ?? c.priceUsdE18);
  const aggregateCap = marketCapUsdE8(aggregatePrice, c.burned);
  await db.update(coin, { address: lc(c.address) }).set((current) => ({
    ...(c.poolId === m.poolId ? {
      sqrtPriceX96: t.sqrtPriceX96, tick: t.tick, poolQuote: current.poolQuote + e.poolQuoteDelta,
      volumeQuote: current.volumeQuote + e.quoteAmount, feesTotal: current.feesTotal + t.fee,
      platformFees: current.platformFees + platformFees, referralFees: current.referralFees + e.split.referral,
      creatorEarned: current.creatorEarned + creatorSplit.launcher, destinationEarned: current.destinationEarned + e.split.destination,
    } : {}),
    priceUsdE18: aggregatePrice, marketCapUsdE8: aggregateCap, athMarketCapUsdE8: max(current.athMarketCapUsdE8, aggregateCap),
    poolCoins: current.poolCoins + e.poolCoinDelta, volumeUsdE8: current.volumeUsdE8 + e.valueUsdE8,
    trades: current.trades + 1, buys: current.buys + (t.isBuy ? 1 : 0), sells: current.sells + (t.isBuy ? 0 : 1), lastTradeAt: t.timestamp,
    devSold: current.devSold || (!t.isBuy && t.trader === lc(c.launcher)),
    snipers: current.snipers + sniperInc, sameBlockBuys: current.sameBlockBuys + sameBlockInc,
  }));

  for (const interval of CANDLE_INTERVALS) {
    const key = { poolId: m.poolId, interval, bucket: bucketStart(t.timestamp, interval) };
    const existing = await db.find(candle, key);
    const next: CandleRow = foldCandle(existing, e, t.isBuy);
    if (existing) await db.update(candle, key).set(next);
    else await db.insert(candle).values({ coin: lc(c.address), ...key, ...next });
    const aggregateKey = { poolId: aggregatePoolId(c.address), interval, bucket: key.bucket };
    const aggregateExisting = await db.find(candle, aggregateKey);
    const aggregateNext = foldCandle(aggregateExisting, {
      ...e, quoteAmount: 0n, priceBeforeUsdE18: c.priceUsdE18, priceUsdE18: aggregatePrice,
      marketCapBeforeUsdE8: c.marketCapUsdE8, marketCapUsdE8: aggregateCap,
    }, t.isBuy);
    if (aggregateExisting) await db.update(candle, aggregateKey).set(aggregateNext);
    else await db.insert(candle).values({ coin: lc(c.address), ...aggregateKey, ...aggregateNext });
  }

  if (t.fee > 0n) {
    const currency = lc(q.address);
    if (attribution) await db.insert(authorLedger).values({ poolId: m.poolId, coin: lc(c.address), quote: currency,
      earned: creatorSplit.author, claimed: 0n, reclaimed: 0n })
      .onConflictDoUpdate((row) => ({ earned: row.earned + creatorSplit.author }));
    await db
      .insert(platformLedger)
      .values({ currency, earned: platformFees, claimed: 0n })
      .onConflictDoUpdate((row) => ({ earned: row.earned + platformFees }));
    if (t.referrer && e.split.referral > 0n) {
      await db
        .insert(referralLedger)
        .values({ referrer: t.referrer, currency, earned: e.split.referral, claimed: 0n, trades: 1 })
        .onConflictDoUpdate((row) => ({ earned: row.earned + e.split.referral, trades: row.trades + 1 }));
    }
  }

  // Average-cost basis for positions, from the trader's own trades.
  if (t.kind !== "buyback") {
    const delta = t.isBuy
      ? { boughtCoins: t.coinAmount, boughtUsdE8: e.valueUsdE8, soldCoins: 0n, soldUsdE8: 0n }
      : { boughtCoins: 0n, boughtUsdE8: 0n, soldCoins: t.coinAmount, soldUsdE8: e.valueUsdE8 };
    await db
      .insert(balance)
      .values({
        coin: lc(c.address),
        account: t.trader,
        amount: 0n,
        excluded: isExcludedHolder(addresses, c.address, t.trader),
        ...delta,
        firstHeldAt: null,
        updatedAt: t.timestamp,
      })
      .onConflictDoUpdate((row) => ({
        boughtCoins: row.boughtCoins + delta.boughtCoins,
        boughtUsdE8: row.boughtUsdE8 + delta.boughtUsdE8,
        soldCoins: row.soldCoins + delta.soldCoins,
        soldUsdE8: row.soldUsdE8 + delta.soldUsdE8,
        updatedAt: t.timestamp,
      }));
  }

  for (const levelUsd of crossedMilestones(c.marketCapUsdE8, aggregateCap)) {
    const first = await db
      .insert(milestone)
      .values({ coin: lc(c.address), levelUsd, tradeId: t.id, blockNumber: t.blockNumber, timestamp: t.timestamp })
      .onConflictDoNothing();
    if (first) {
      await db.insert(activity).values({
        id: `milestone-${lc(c.address)}-${levelUsd}`,
        kind: "milestone",
        coin: lc(c.address),
        amountQuote: null,
        amountCoins: null,
        milestoneUsd: levelUsd,
        blockNumber: t.blockNumber,
        logIndex: t.logIndex,
        timestamp: t.timestamp,
        txHash: t.txHash,
      });
    }
  }
}
