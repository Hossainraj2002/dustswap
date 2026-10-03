// SYNCED from apps/memefun/src/lib/market/types.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
import type { Address, CoinLinks, CoinTerms, Hash, QuoteAsset, TradeSide } from "./core/types";

export interface ModeStats {
  /** Every fee this coin has paid, in quote units. */
  feesTotalQuote: number;
  platformQuote: number;
  referralQuote: number;
  /** Creator's lifetime earnings (creator mode, or the creator's keep share). */
  creatorEarnedQuote: number;
  creatorClaimedQuote: number;
  /** Buyback and burn. */
  burnedCoins: number;
  burnBudgetQuote: number;
  buybacks: number;
  /** Holder rewards. */
  holdersPaidQuote: number;
  epochPendingQuote: number;
  nextEpochAt: number;
  epochs: number;
  /** Liquidity floor. */
  floorQuote: number;
  floorPriceUsd: number;
}

export interface Coin {
  address: Address;
  name: string;
  symbol: string;
  description: string;
  image: string;
  links: CoinLinks;
  creator: Address;
  createdAt: number;
  quote: QuoteAsset;
  terms: CoinTerms;
  /** Coin price in quote units and in USD. */
  priceQuote: number;
  priceUsd: number;
  /** Price x circulating supply (burned coins excluded). */
  marketCapUsd: number;
  /** Price x total supply. */
  fdvUsd: number;
  openingMarketCapUsd: number;
  athMarketCapUsd: number;
  /** Quote held by the pool plus the value of coins still in it, DexScreener style. */
  liquidityUsd: number;
  volume24hUsd: number;
  volumeTotalUsd: number;
  change5m: number;
  change1h: number;
  change24h: number;
  holders: number;
  /** Coins outside the pool and not burned. */
  circulating: number;
  buys24h: number;
  sells24h: number;
  lastTradeAt: number;
  /** 48 USD prices across the last 24h (or since launch). */
  sparkline: number[];
  stats: ModeStats;
  /** Trending score. */
  momentum: number;
  devHoldsPct: number;
  devSold: boolean;
  top10Pct: number;
  /** Wallets that bought during launch protection (excluding the creator's first buy). */
  snipers: number;
  sameBlockBuys: number;
  milestonesReached: number;
  hidden?: boolean;
  featured?: boolean;
}

export interface Trade {
  id: string;
  coin: Address;
  ts: number;
  side: TradeSide;
  trader: Address;
  quoteAmount: number;
  coinAmount: number;
  priceUsd: number;
  marketCapUsd: number;
  feeQuote: number;
  feeBps: number;
  txHash: Hash;
  isCreator: boolean;
  inProtection: boolean;
}

export interface Candle {
  /** Bucket start, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type HolderLabel = "pool" | "burn" | "floor" | "creator" | "you";

export interface Holder {
  address: Address;
  balance: number;
  pct: number;
  label?: HolderLabel;
}

export type ActivityKind = "trade" | "launch" | "burn" | "payout" | "floor" | "milestone";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  coin: Address;
  ts: number;
  trade?: Trade;
  amountQuote?: number;
  amountCoins?: number;
  milestone?: number;
}

export interface Comment {
  id: string;
  coin: Address;
  author: Address;
  body: string;
  ts: number;
  isCreator: boolean;
}

export interface CreatorProfile {
  address: Address;
  name: string;
  coins: Address[];
  earnedUsd: number;
  volumeUsd: number;
  joinedAt: number;
}

export interface Position {
  coin: Address;
  balance: number;
  costBasisUsd: number;
  valueUsd: number;
  pnlUsd: number;
}

export interface Claimable {
  coin: Address;
  kind: "creator" | "holders" | "referral";
  amountQuote: number;
  quoteSymbol: string;
  amountUsd: number;
  epoch?: number;
  /** Live: the asset paid out (FeeVault keeps referral fees per asset). */
  currency?: string;
  /** Live: the exact amount, in the asset's units. */
  amountRaw?: string;
  /** Live holder rewards: the published Merkle leaf. */
  index?: string;
  proof?: string[];
  /** Live holder rewards: claiming opens after the 12-hour veto window and closes after 90 days. */
  claimableAt?: number;
  expiresAt?: number;
}

export type CandleInterval = 60 | 300 | 900 | 3600 | 14400 | 86400;

export const CANDLE_INTERVALS: Array<{ value: CandleInterval; label: string }> = [
  { value: 60, label: "1m" },
  { value: 300, label: "5m" },
  { value: 900, label: "15m" },
  { value: 3600, label: "1h" },
  { value: 14400, label: "4h" },
  { value: 86400, label: "1D" },
];
