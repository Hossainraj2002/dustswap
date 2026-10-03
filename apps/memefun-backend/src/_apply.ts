import type { Context } from "ponder:registry";
import {
  activity,
  balance,
  candle,
  coin,
  launchBlock,
  launchBlockBuyer,
  milestone,
  platformLedger,
  type quote,
  referralLedger,
  sniper,
  trade,
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
} from "../lib/indexer/effects";
import { addresses } from "../lib/indexer/runtime";

/**
 * Shared by the Trade handler and the Launched handler (which applies a coin's first buy once the
 * coin is complete). Not an indexing file: it registers nothing.
 */
export type CoinRow = typeof coin.$inferSelect;
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
  q: QuoteRow,
  t: RawTrade,
  quoteUsdE8: bigint,
  options: { existingRow: boolean },
) {
  const db = context.db;
  const e = tradeEffects(c, { burned: c.burned, priceUsdE18: c.priceUsdE18 }, { decimals: q.decimals, priceUsdE8: quoteUsdE8 }, t);
  const isCreator = t.trader === lc(c.creator) || t.trader === lc(c.launcher);

  const row = {
    coin: lc(c.address),
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

  await db.update(coin, { address: lc(c.address) }).set((current) => ({
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
    platformFees: current.platformFees + e.split.platform,
    referralFees: current.referralFees + e.split.referral,
    creatorEarned: current.creatorEarned + e.split.creator,
    destinationEarned: current.destinationEarned + e.split.destination,
    devSold: current.devSold || (!t.isBuy && t.trader === lc(c.launcher)),
    snipers: current.snipers + sniperInc,
    sameBlockBuys: current.sameBlockBuys + sameBlockInc,
  }));

  for (const interval of CANDLE_INTERVALS) {
    const key = { coin: lc(c.address), interval, bucket: bucketStart(t.timestamp, interval) };
    const existing = await db.find(candle, key);
    const next: CandleRow = foldCandle(existing, e, t.isBuy);
    if (existing) await db.update(candle, key).set(next);
    else await db.insert(candle).values({ ...key, ...next });
  }

  if (t.fee > 0n) {
    const currency = lc(q.address);
    await db
      .insert(platformLedger)
      .values({ currency, earned: e.split.platform, claimed: 0n })
      .onConflictDoUpdate((row) => ({ earned: row.earned + e.split.platform }));
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

  for (const levelUsd of e.milestones) {
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
