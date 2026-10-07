import type { LaunchSettings } from "@/core/settings";
import type { Address, CoinLinks, FeeMode, Hash, QuoteAsset, TradeSide } from "@/core/types";
import type { AuthorReward, AuthorSession, TweetDraft, TweetImport } from "@/lib/create/tweet";
import type { PairCatalogSort } from "./pairs";
import type {
  ActivityItem,
  Candle,
  CandleInterval,
  Claimable,
  Coin,
  Comment,
  CreatorProfile,
  Holder,
  Position,
  Trade,
} from "./types";

/**
 * What every screen reads and does, whoever provides the market: the simulated PreviewMarket in
 * preview, or LiveMarket on a real deployment. Reads are synchronous (live data is cached and
 * refreshed in the background; `subscribe` fires when it changes); actions are promises.
 */
export interface Market {
  readonly kind: "preview" | "live";

  subscribe(listener: () => void): () => void;
  getVersion(): number;
  start(): void;
  stop(): void;

  listCoins(includeHidden?: boolean): Coin[];
  /** False until the first live coin list finishes loading; cached refreshes stay ready. */
  isCoinsReady?(): boolean;
  getCoin(address: string): Coin | undefined;
  getTrades(address: string, limit?: number, poolId?: Hash): Trade[];
  getComments(address: string): Comment[];
  getActivity(limit?: number): ActivityItem[];
  getCandles(address: string, interval: CandleInterval, metric?: "price" | "mcap", poolId?: Hash): Candle[];
  getHolders(address: string, viewer?: Address, limit?: number): Holder[];
  getCreators(): CreatorProfile[];
  creatorProfile(address: string): CreatorProfile | undefined;
  getTradesByTrader(trader: string, limit?: number): Trade[];
  getSettings(): LaunchSettings;
  isSettingsReady(): boolean;
  /** Pair assets new coins can launch with, ETH first. */
  listQuotes(): QuoteAsset[];
  /** Complete discovery catalog, including assets that cannot currently launch. */
  listPairCatalog?(sort?: PairCatalogSort): QuoteAsset[];
  getPairCatalogNotice?(sort?: PairCatalogSort): string | undefined;
  getModeration(): Moderation;
  /** Whether the data behind the screens is current (live mode reports outages here). */
  getStatus(): MarketStatus;

  ensureUser(address: Address, preset?: "default" | "poor" | "creator"): void;
  getQuoteBalance(address: Address, pairId: string): number;
  getCoinBalance(address: Address, coin: string): number;
  getPositions(address: Address): Position[];
  getClaimables(address: Address): Claimable[];

  quote(coinAddress: string, side: TradeSide, amountIn: number, now?: number, payWithEth?: boolean, poolId?: Hash): MarketQuote;
  trade(user: Address, coinAddress: string, side: TradeSide, amountIn: number, minOut: number, options?: TradeOptions): Promise<Trade>;
  launch(user: Address, input: LaunchInput, outcome?: TxOutcome, onStage?: (stage: TxStage) => void): Promise<Coin>;
  claim(user: Address, items: Claimable[], outcome?: TxOutcome, onStage?: (stage: TxStage) => void, to?: Address): Promise<Hash>;
  lowerFee(user: Address, coin: Address, feeBps: number, onStage?: (stage: TxStage) => void): Promise<Hash>;
  proposeCreator(user: Address, coin: Address, proposed: Address, onStage?: (stage: TxStage) => void): Promise<Hash>;
  acceptCreator(user: Address, coin: Address, onStage?: (stage: TxStage) => void): Promise<Hash>;
  importTweet(url: string): Promise<TweetImport>;
  getAuthorSession(user?: Address): AuthorSession | null;
  beginAuthorVerification(user: Address, coin?: Address): Promise<void>;
  bindAuthorWallet(user: Address, coin: Address): Promise<void>;
  getAuthorRewards(user?: Address): AuthorReward[];
  claimAuthorRewards(user: Address, coin: Address): Promise<Hash>;
  isAuthorTreasury(user?: Address): boolean;
  getTreasuryAuthorRewards(user: Address, coin: Address): Promise<AuthorReward[]>;
  claimTreasuryAuthorRewards(user: Address, coin: Address, poolId: Hash): Promise<Hash>;
  addComment(author: Address, coinAddress: string, body: string): Promise<Comment>;

  /** Admin: the owner's settings change (live: one transaction per changed setting). */
  updateSettings(next: LaunchSettings): Promise<void>;
  setHidden(address: Address, hidden: boolean, adminToken?: string): Promise<void>;
  setFeatured(address: Address, featured: boolean, adminToken?: string): Promise<void>;
  setBanner(text: string, adminToken?: string): Promise<void>;
}

export interface MarketStatus {
  state: "ready" | "loading" | "offline" | "misconfigured";
  message?: string;
}

export interface Moderation {
  hidden: Address[];
  featured: Address[];
  banner: string;
}

export type TxOutcome = "ok" | "rejected" | "reverted";

/** What a live action is waiting on right now, for button labels. */
export type TxStage = "upload" | "approve" | "sign" | "confirm" | "pending";

export interface MarketQuote {
  side: TradeSide;
  amountIn: number;
  amountOut: number;
  /** Live: exact quoted output, in the receiving asset's raw units. */
  amountOutRaw?: string;
  feeQuote: number;
  feeBps: number;
  priceImpact: number;
  priceAfterUsd: number;
  marketCapAfterUsd: number;
  ok: boolean;
  reason?: string;
  /** Pay-with-ETH buys: the pair-asset amount the ETH converts into first. */
  routedQuoteIn?: number;
}

export interface TradeOptions {
  poolId?: Hash;
  /** Preview only: the outcome a scenario forces. */
  outcome?: TxOutcome;
  referrer?: Address;
  payWithEth?: boolean;
  /** The amount exactly as typed, so no floating-point rounding reaches the chain. */
  amountText?: string;
  /** Sell the whole balance, to the last unit. */
  max?: boolean;
  slippageBps?: number;
  /** Exact minimum shown before submission; fresh quotes must not lower this floor. */
  minAmountOutRaw?: string;
  onStage?: (stage: TxStage) => void;
}

export interface LaunchInput {
  tweet?: TweetDraft;
  name: string;
  symbol: string;
  description: string;
  /** The prepared image as a data URL (512 px WebP from create/image.ts). */
  image: string;
  links: CoinLinks;
  quote: QuoteAsset;
  feeBps: number;
  mode: FeeMode;
  creatorKeepBps: number;
  firstBuyQuote: number;
  /** The first buy exactly as typed. */
  firstBuyText?: string;
  /** One token with up to five pools. Omitted means the legacy single pool. */
  markets?: LaunchMarketInput[];
}

export interface LaunchMarketInput {
  quote: QuoteAsset;
  firstBuyQuote: number;
  firstBuyText?: string;
}

/**
 * A wallet action that did not happen. `kind` drives the screens: a rejection is the person's own
 * choice (a quiet toast), anything else is an error with a reason.
 */
export class TxError extends Error {
  constructor(
    message: string,
    readonly kind: "rejected" | "reverted" | "insufficient",
    readonly hash?: Hash,
  ) {
    super(message);
    this.name = "TxError";
  }
}
