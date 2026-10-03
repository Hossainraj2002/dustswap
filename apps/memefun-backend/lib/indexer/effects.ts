import { type FeeSplit, splitFee } from "../../shared/core/fees";
import { MILESTONES_USD } from "../../shared/core/milestones";
import type { FeeMode } from "../../shared/core/types";
import { marketCapUsdE8, priceUsdE18, quoteValueUsdE8 } from "../market/math";
import type { TradeKind } from "./addresses";

/** MemeFunTypes.Mode order. */
export const MODES: readonly FeeMode[] = ["creator", "burn", "holders", "floor"];

export function modeName(mode: number): FeeMode {
  const name = MODES[mode];
  if (!name) throw new Error(`unknown fee mode ${mode}`);
  return name;
}

export interface CoinTerms {
  mode: number;
  quoteIsCurrency0: boolean;
  platformShareBps: number;
  referralShareBps: number;
  creatorKeepBps: number;
  createdAt: number;
  protectionDurationSec: number;
}

export interface CoinMarket {
  burned: bigint;
  priceUsdE18: bigint;
}

export interface TradeEvent {
  kind: TradeKind;
  isBuy: boolean;
  /** As emitted: the buyer's gross payment, or the pool's gross output on a sell. */
  quoteAmount: bigint;
  coinAmount: bigint;
  fee: bigint;
  referrer: string | null;
  sqrtPriceX96: bigint;
  timestamp: number;
}

export interface TradeEffects {
  /** What the trader paid (buy, fee included) or received (sell, fee taken). */
  quoteAmount: bigint;
  poolQuoteDelta: bigint;
  poolCoinDelta: bigint;
  valueUsdE8: bigint;
  priceBeforeUsdE18: bigint;
  priceUsdE18: bigint;
  marketCapBeforeUsdE8: bigint;
  marketCapUsdE8: bigint;
  split: FeeSplit;
  inProtection: boolean;
  /** Market-cap milestones (USD) this trade crossed upward. */
  milestones: number[];
}

/**
 * Everything one Trade changes, computed exactly. The fee split is FeeVault's own (FeeMath.split,
 * mirrored by shared/core/fees.ts and pinned by golden vectors), since the vault emits no event
 * for credits.
 */
export function tradeEffects(
  terms: CoinTerms,
  market: CoinMarket,
  quote: { decimals: number; priceUsdE8: bigint },
  trade: TradeEvent,
): TradeEffects {
  const side = { quoteIsCurrency0: terms.quoteIsCurrency0, quoteDecimals: quote.decimals };
  const quoteAmount = trade.isBuy ? trade.quoteAmount : trade.quoteAmount - trade.fee;
  const poolQuoteDelta = trade.isBuy ? trade.quoteAmount - trade.fee : -trade.quoteAmount;
  const poolCoinDelta = trade.isBuy ? -trade.coinAmount : trade.coinAmount;
  const price = priceUsdE18(trade.sqrtPriceX96, side, quote.priceUsdE8);
  const marketCapBefore = marketCapUsdE8(market.priceUsdE18, market.burned);
  const marketCap = marketCapUsdE8(price, market.burned);
  const hasReferrer = trade.referrer !== null && BigInt(trade.referrer) !== 0n;
  const split = splitFee(
    trade.fee,
    {
      mode: modeName(terms.mode),
      platformShareBps: terms.platformShareBps,
      referralShareBps: terms.referralShareBps,
      creatorKeepBps: terms.creatorKeepBps,
    },
    hasReferrer,
  );
  return {
    quoteAmount,
    poolQuoteDelta,
    poolCoinDelta,
    valueUsdE8: quoteValueUsdE8(quoteAmount, quote.decimals, quote.priceUsdE8),
    priceBeforeUsdE18: market.priceUsdE18,
    priceUsdE18: price,
    marketCapBeforeUsdE8: marketCapBefore,
    marketCapUsdE8: marketCap,
    split,
    inProtection: trade.kind !== "first_buy" && trade.timestamp - terms.createdAt < terms.protectionDurationSec,
    milestones: crossedMilestones(marketCapBefore, marketCap),
  };
}

/** Every milestone strictly above `beforeE8` and at or below `afterE8`. */
export function crossedMilestones(beforeE8: bigint, afterE8: bigint): number[] {
  const crossed: number[] = [];
  for (const level of MILESTONES_USD) {
    const levelE8 = BigInt(level) * 100_000_000n;
    if (beforeE8 < levelE8 && afterE8 >= levelE8) crossed.push(level);
  }
  return crossed;
}

export const CANDLE_INTERVALS = [60, 300, 900, 3600, 14400, 86400] as const;

export interface CandleRow {
  openUsdE18: bigint;
  highUsdE18: bigint;
  lowUsdE18: bigint;
  closeUsdE18: bigint;
  openMcapUsdE8: bigint;
  highMcapUsdE8: bigint;
  lowMcapUsdE8: bigint;
  closeMcapUsdE8: bigint;
  volumeUsdE8: bigint;
  volumeQuote: bigint;
  trades: number;
  buys: number;
}

export function bucketStart(timestamp: number, interval: number): number {
  return Math.floor(timestamp / interval) * interval;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Folds one trade into its candle. A new candle opens at the price before the trade (the previous
 * close), so the chart has no gaps between buckets; a coin's very first trade opens at the
 * launch price, which is the coin's price before any trade.
 */
export function foldCandle(existing: CandleRow | null, effects: TradeEffects, isBuy: boolean): CandleRow {
  const price = effects.priceUsdE18;
  const mcap = effects.marketCapUsdE8;
  if (!existing) {
    const open = effects.priceBeforeUsdE18 > 0n ? effects.priceBeforeUsdE18 : price;
    const openMcap = effects.priceBeforeUsdE18 > 0n ? effects.marketCapBeforeUsdE8 : mcap;
    return {
      openUsdE18: open,
      highUsdE18: max(open, price),
      lowUsdE18: min(open, price),
      closeUsdE18: price,
      openMcapUsdE8: openMcap,
      highMcapUsdE8: max(openMcap, mcap),
      lowMcapUsdE8: min(openMcap, mcap),
      closeMcapUsdE8: mcap,
      volumeUsdE8: effects.valueUsdE8,
      volumeQuote: effects.quoteAmount,
      trades: 1,
      buys: isBuy ? 1 : 0,
    };
  }
  return {
    ...existing,
    highUsdE18: max(existing.highUsdE18, price),
    lowUsdE18: min(existing.lowUsdE18, price),
    closeUsdE18: price,
    highMcapUsdE8: max(existing.highMcapUsdE8, mcap),
    lowMcapUsdE8: min(existing.lowMcapUsdE8, mcap),
    closeMcapUsdE8: mcap,
    volumeUsdE8: existing.volumeUsdE8 + effects.valueUsdE8,
    volumeQuote: existing.volumeQuote + effects.quoteAmount,
    trades: existing.trades + 1,
    buys: existing.buys + (isBuy ? 1 : 0),
  };
}

/** Same-block signal: a block's 2nd distinct buyer counts both, every later one counts itself. */
export function sameBlockIncrement(buyersInBlockAfterInsert: number): number {
  if (buyersInBlockAfterInsert === 2) return 2;
  return buyersInBlockAfterInsert > 2 ? 1 : 0;
}

/** Window after launch in which buys are checked for the same-block signal. */
export const SAME_BLOCK_WINDOW_SEC = 60;
