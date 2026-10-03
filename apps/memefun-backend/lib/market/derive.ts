import { type Address, getAddress } from "viem";

import { COIN_SUPPLY, COIN_SUPPLY_HUMAN } from "../../shared/core/constants";
import { milestoneProgress } from "../../shared/core/milestones";
import type { CoinLinks, QuoteAsset, QuoteKind } from "../../shared/core/types";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";
import type { Candle, Coin, ModeStats, Trade } from "../../shared/market-types";
import { modeName } from "../indexer/effects";
import { marketCapUsdE8, priceQuoteWad, priceUsdE18, priceUsdE18AtTick, toNumber } from "./math";

/**
 * Indexed rows to the app's own types (shared/market-types.ts). Pure functions: the read API
 * feeds them rows and caches the results. Live numbers (price, caps, liquidity) use the pair
 * asset's CURRENT USD price; history (volumes, candles, ATH) keeps the USD value it had when it
 * happened, which is what a chart of USD prices means.
 */

export interface CoinRecord {
  address: string;
  creator: string;
  launcher: string;
  quote: string;
  quoteIsCurrency0: boolean;
  mode: number;
  module: string;
  feeBps: number;
  platformShareBps: number;
  referralShareBps: number;
  creatorKeepBps: number;
  protectionStartBps: number;
  protectionDurationSec: number;
  createdAt: number;
  name: string;
  symbol: string;
  contractUri: string;
  startTick: number;
  launchQuoteUsdE8: bigint;
  sqrtPriceX96: bigint;
  poolQuote: bigint;
  poolCoins: bigint;
  burned: bigint;
  athMarketCapUsdE8: bigint;
  volumeUsdE8: bigint;
  trades: number;
  lastTradeAt: number;
  holders: number;
  feesTotal: bigint;
  platformFees: bigint;
  referralFees: bigint;
  creatorEarned: bigint;
  creatorClaimed: bigint;
  destinationEarned: bigint;
  buybacks: number;
  buybackSpent: bigint;
  buybackBurned: bigint;
  floorQuote: bigint;
  floorNearTick: number | null;
  holdersReserved: bigint;
  holdersReturned: bigint;
  epochs: number;
  devSold: boolean;
  snipers: number;
  sameBlockBuys: number;
}

export interface QuoteRecord {
  address: string;
  kind: number;
  decimals: number;
  symbol: string;
  name: string;
  priceUsdE8: bigint;
}

/** Rolling-window numbers the snapshot computes from candles. */
export interface CoinWindows {
  volume24hUsdE8: bigint;
  buys24h: number;
  sells24h: number;
  volume1hUsdE8: bigint;
  trades15m: number;
  /** USD prices (18 decimals) 5 minutes, 1 hour and 24 hours ago; null when the coin is younger. */
  priceAgoUsdE18: { m5: bigint | null; h1: bigint | null; h24: bigint | null };
  /** 48 USD prices across the last 24 hours (or since launch), oldest first. */
  sparkline: number[];
}

export interface HolderStats {
  top10: bigint;
  creatorBalance: bigint;
}

export interface CoinMetadataView {
  description: string;
  image: string;
  links: CoinLinks;
}

export const EMPTY_WINDOWS: CoinWindows = {
  volume24hUsdE8: 0n,
  buys24h: 0,
  sells24h: 0,
  volume1hUsdE8: 0n,
  trades15m: 0,
  priceAgoUsdE18: { m5: null, h1: null, h24: null },
  sparkline: [],
};

const QUOTE_KINDS: readonly QuoteKind[] = ["native", "stable", "stock"];

export function quoteKind(kind: number): QuoteKind {
  return QUOTE_KINDS[kind] ?? "stable";
}

export function toQuoteAsset(q: QuoteRecord): QuoteAsset {
  return {
    address: getAddress(q.address),
    symbol: q.symbol,
    name: q.name,
    decimals: q.decimals,
    kind: quoteKind(q.kind),
    usdPrice: toNumber.usdE8(q.priceUsdE8),
  };
}

/** Holder-reward epochs end at 00:00 and 12:00 UTC. */
export const EPOCH_SECONDS = 12 * 60 * 60;

export function nextEpochAt(nowSec: number): number {
  return (Math.floor(nowSec / EPOCH_SECONDS) + 1) * EPOCH_SECONDS;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function change(nowE18: bigint, thenE18: bigint | null): number {
  if (thenE18 === null || thenE18 <= 0n) return 0;
  return Number((nowE18 * 1_000_000_000n) / thenE18) / 1e9 - 1;
}

/** The app's trending score (see the preview engine): last-hour volume, momentum, fresh coins first. */
export function momentumScore(input: { volume1hUsd: number; change1h: number; trades15m: number; ageSec: number }): number {
  const ageHours = Math.max(0.05, input.ageSec / 3600);
  const freshness = ageHours < 1 ? 1.6 : ageHours < 6 ? 1.2 : 1;
  return (input.volume1hUsd * (1 + clamp(input.change1h, -0.6, 3)) + input.trades15m * 40) * freshness;
}

export function openingMarketCapUsdE8(c: CoinRecord, quoteDecimals: number): bigint {
  const price = priceUsdE18(getSqrtPriceAtTick(c.startTick), { quoteIsCurrency0: c.quoteIsCurrency0, quoteDecimals }, c.launchQuoteUsdE8);
  return marketCapUsdE8(price, 0n);
}

export function deriveCoin(input: {
  coin: CoinRecord;
  quote: QuoteRecord;
  windows: CoinWindows;
  holders: HolderStats;
  metadata: CoinMetadataView | null;
  flags: { hidden: boolean; featured: boolean };
  nowSec: number;
}): Coin {
  const { coin: c, quote: q, windows: w } = input;
  const side = { quoteIsCurrency0: c.quoteIsCurrency0, quoteDecimals: q.decimals };
  const decimals = q.decimals;
  const units = (value: bigint) => toNumber.units(value, decimals);

  const priceE18 = priceUsdE18(c.sqrtPriceX96, side, q.priceUsdE8);
  const marketCapE8 = marketCapUsdE8(priceE18, c.burned);
  const openingE8 = openingMarketCapUsdE8(c, decimals);
  const athE8 = c.athMarketCapUsdE8 > marketCapE8 ? c.athMarketCapUsdE8 : marketCapE8;
  const priceUsd = toNumber.usdE18(priceE18);
  const marketCapUsd = toNumber.usdE8(marketCapE8);
  const liquidityUsd = units(c.poolQuote) * toNumber.usdE8(q.priceUsdE8) + toNumber.coins(c.poolCoins) * priceUsd;
  const circulating = COIN_SUPPLY - c.poolCoins - c.burned;
  const change1h = change(priceE18, w.priceAgoUsdE18.h1);
  const mode = modeName(c.mode);
  const distributed = c.holdersReserved - c.holdersReturned;

  const stats: ModeStats = {
    feesTotalQuote: units(c.feesTotal),
    platformQuote: units(c.platformFees),
    referralQuote: units(c.referralFees),
    creatorEarnedQuote: units(c.creatorEarned),
    creatorClaimedQuote: units(c.creatorClaimed),
    burnedCoins: toNumber.coins(c.buybackBurned),
    burnBudgetQuote: mode === "burn" ? units(c.destinationEarned - c.buybackSpent) : 0,
    buybacks: c.buybacks,
    holdersPaidQuote: mode === "holders" ? units(distributed) : 0,
    epochPendingQuote: mode === "holders" ? units(c.destinationEarned - distributed) : 0,
    nextEpochAt: nextEpochAt(input.nowSec) * 1000,
    epochs: c.epochs,
    floorQuote: mode === "floor" ? units(c.floorQuote) : 0,
    floorPriceUsd: c.floorNearTick === null ? 0 : toNumber.usdE18(priceUsdE18AtTick(c.floorNearTick, side, q.priceUsdE8)),
  };

  return {
    address: getAddress(c.address),
    name: c.name,
    symbol: c.symbol,
    description: input.metadata?.description ?? "",
    image: input.metadata?.image ?? "",
    links: input.metadata?.links ?? {},
    creator: getAddress(c.creator),
    createdAt: c.createdAt * 1000,
    quote: toQuoteAsset(q),
    terms: {
      feeBps: c.feeBps,
      mode,
      creatorKeepBps: c.creatorKeepBps,
      platformShareBps: c.platformShareBps,
      referralShareBps: c.referralShareBps,
      snipeStartBps: c.protectionStartBps,
      snipeDurationSec: c.protectionDurationSec,
    },
    priceQuote: toNumber.wad(priceQuoteWad(c.sqrtPriceX96, side)),
    priceUsd,
    marketCapUsd,
    fdvUsd: priceUsd * COIN_SUPPLY_HUMAN,
    openingMarketCapUsd: toNumber.usdE8(openingE8),
    athMarketCapUsd: toNumber.usdE8(athE8),
    liquidityUsd,
    volume24hUsd: toNumber.usdE8(w.volume24hUsdE8),
    volumeTotalUsd: toNumber.usdE8(c.volumeUsdE8),
    change5m: change(priceE18, w.priceAgoUsdE18.m5),
    change1h,
    change24h: change(priceE18, w.priceAgoUsdE18.h24),
    holders: c.holders,
    circulating: toNumber.coins(circulating > 0n ? circulating : 0n),
    buys24h: w.buys24h,
    sells24h: w.sells24h,
    lastTradeAt: c.lastTradeAt * 1000,
    sparkline: w.sparkline.length > 0 ? [...w.sparkline.slice(0, -1), priceUsd] : Array.from({ length: 48 }, () => priceUsd),
    stats,
    momentum: momentumScore({
      volume1hUsd: toNumber.usdE8(w.volume1hUsdE8),
      change1h,
      trades15m: w.trades15m,
      ageSec: input.nowSec - c.createdAt,
    }),
    devHoldsPct: toNumber.coins(input.holders.creatorBalance) / COIN_SUPPLY_HUMAN,
    devSold: c.devSold,
    top10Pct: toNumber.coins(input.holders.top10) / COIN_SUPPLY_HUMAN,
    snipers: c.snipers,
    sameBlockBuys: c.sameBlockBuys,
    milestonesReached: milestoneProgress(marketCapUsd, toNumber.usdE8(openingE8)).reached,
    ...(input.flags.hidden ? { hidden: true } : {}),
    ...(input.flags.featured ? { featured: true } : {}),
  };
}

export interface TradeRecord {
  id: string;
  coin: string;
  trader: string;
  kind: string;
  isBuy: boolean;
  quoteAmount: bigint;
  coinAmount: bigint;
  fee: bigint;
  feeBps: number;
  priceUsdE18: bigint;
  marketCapUsdE8: bigint;
  isCreator: boolean;
  inProtection: boolean;
  timestamp: number;
  txHash: `0x${string}`;
}

/** A trade as the app shows it, plus `kind` so a buyback or a first buy can be labelled. */
export type TradeView = Trade & { kind: string };

export function deriveTrade(t: TradeRecord, quoteDecimals: number): TradeView {
  return {
    id: t.id,
    coin: getAddress(t.coin),
    ts: t.timestamp * 1000,
    side: t.isBuy ? "buy" : "sell",
    trader: getAddress(t.trader),
    quoteAmount: toNumber.units(t.quoteAmount, quoteDecimals),
    coinAmount: toNumber.coins(t.coinAmount),
    priceUsd: toNumber.usdE18(t.priceUsdE18),
    marketCapUsd: toNumber.usdE8(t.marketCapUsdE8),
    feeQuote: toNumber.units(t.fee, quoteDecimals),
    feeBps: t.feeBps,
    txHash: t.txHash,
    isCreator: t.isCreator,
    inProtection: t.inProtection,
    kind: t.kind,
  };
}

export interface CandleRecord {
  bucket: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volumeUsdE8: bigint;
}

/**
 * Continuous candles over [startSec, endSec] like the preview chart: a bucket without trades is a
 * flat candle at the previous close, so the chart never has holes. `openingValue` is the value
 * before the first candle (the price or market cap at launch, or the last close before the range).
 */
export function fillCandles(input: {
  candles: CandleRecord[];
  interval: number;
  startSec: number;
  endSec: number;
  openingValue: bigint;
  scale: "usdE18" | "usdE8";
}): Candle[] {
  const toValue = input.scale === "usdE18" ? toNumber.usdE18 : toNumber.usdE8;
  const byBucket = new Map(input.candles.map((c) => [c.bucket, c]));
  const out: Candle[] = [];
  let previous = input.openingValue;
  const first = Math.floor(input.startSec / input.interval) * input.interval;
  for (let bucket = first; bucket <= input.endSec; bucket += input.interval) {
    const c = byBucket.get(bucket);
    if (c) {
      out.push({ time: bucket, open: toValue(c.open), high: toValue(c.high), low: toValue(c.low), close: toValue(c.close), volume: toNumber.usdE8(c.volumeUsdE8) });
      previous = c.close;
    } else {
      const value = toValue(previous);
      out.push({ time: bucket, open: value, high: value, low: value, close: value, volume: 0 });
    }
  }
  return out;
}

/** 48 prices from `fromSec` to `nowSec`, each the last close at or before its moment. */
export function sparklineFrom(input: {
  closes: Array<{ bucket: number; close: bigint }>;
  interval: number;
  fromSec: number;
  nowSec: number;
  priceBeforeE18: bigint;
}): number[] {
  const points: number[] = [];
  const closes = [...input.closes].sort((a, b) => a.bucket - b.bucket);
  let index = 0;
  let last = input.priceBeforeE18;
  const steps = 47;
  for (let step = 0; step <= steps; step += 1) {
    const at = input.fromSec + ((input.nowSec - input.fromSec) * step) / steps;
    while (index < closes.length && closes[index]!.bucket <= at) {
      last = closes[index]!.close;
      index += 1;
    }
    points.push(toNumber.usdE18(last));
  }
  return points;
}

export function coinValue(amount: bigint, coinPriceUsdE18: bigint): number {
  return toNumber.usdE8((amount * coinPriceUsdE18) / 10n ** 28n);
}

/** Average-cost basis of a balance, from the account's own trades. */
export function costBasisUsd(input: { amount: bigint; boughtCoins: bigint; boughtUsdE8: bigint; priceUsdE18: bigint }): number {
  const { amount, boughtCoins, boughtUsdE8 } = input;
  if (amount <= 0n) return 0;
  if (boughtCoins <= 0n) return coinValue(amount, input.priceUsdE18);
  const covered = amount < boughtCoins ? amount : boughtCoins;
  const basisE8 = (boughtUsdE8 * covered) / boughtCoins;
  const extra = amount - covered;
  return toNumber.usdE8(basisE8) + coinValue(extra, input.priceUsdE18);
}

export function addressOrNull(value: string | null | undefined): Address | null {
  try {
    return value ? getAddress(value) : null;
  } catch {
    return null;
  }
}
