// SYNCED from apps/memefun/src/core/types.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
export type Address = `0x${string}`;
export type Hash = `0x${string}`;

/** Where the non-platform share of every trading fee goes. Fixed at launch. */
export type FeeMode = "creator" | "burn" | "holders" | "floor";

export type QuoteKind = "native" | "stable" | "stock";

export interface QuoteAsset {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: QuoteKind;
  /** USD value of one whole unit. For stocks this is the Chainlink NAV. */
  usdPrice: number;
  /** Stocks only: US equity market session state behind the NAV feed. */
  marketOpen?: boolean;
  /** Stocks only: ISIN from the Coinbase registry. */
  isin?: string;
  iconUrl?: string;
}

/** Immutable per-coin terms, snapshotted from the launch settings at launch. */
export interface CoinTerms {
  /** Normal trading fee, in basis points of the trade's quote amount. */
  feeBps: number;
  mode: FeeMode;
  /** Community modes only: creator's slice of the non-platform share. */
  creatorKeepBps: number;
  platformShareBps: number;
  referralShareBps: number;
  snipeStartBps: number;
  snipeDurationSec: number;
}

export interface CoinLinks {
  x?: string;
  telegram?: string;
  website?: string;
}

export type TradeSide = "buy" | "sell";
