/**
 * Preview market: a deterministic simulation of memefun on the same economics
 * as the real pools. Each coin is the constant-product curve of a single-sided
 * v4 position (virtual quote reserve = opening market cap), every trade pays
 * the coin's fee in the quote asset, and fees flow to the platform, the
 * referrer, the creator and the coin's destination exactly as split by
 * src/core/fees. Buybacks, holder epochs, floor liquidity and launch
 * protection all run on that money.
 *
 * Preview only. Phase 4 swaps this source for the live indexer API behind the
 * same MarketSource interface.
 */
import { BPS, COIN_SUPPLY_HUMAN, DEAD_ADDRESS } from "@/core/constants";
import { launchFeeBps } from "@/core/antiSnipe";
import { feeShareFractions } from "@/core/fees";
import { crossedMilestone, milestoneProgress } from "@/core/milestones";
import { DEFAULT_SETTINGS, type LaunchSettings } from "@/core/settings";
import type { Address, CoinLinks, CoinTerms, FeeMode, QuoteAsset, TradeSide } from "@/core/types";
import { ETH, PREVIEW_STOCKS, QUOTES, USDC } from "@/lib/market/quotes";
import { type LaunchInput, type Market, type MarketQuote, type MarketStatus, TxError } from "@/lib/market/Market";
import type {
  ActivityItem,
  Candle,
  CandleInterval,
  Claimable,
  Coin,
  Comment,
  CreatorProfile,
  Holder,
  ModeStats,
  Position,
  Trade,
} from "@/lib/market/types";
import { PREVIEW_COINS, PREVIEW_COMMENTS, PREVIEW_CREATOR_NAMES } from "./catalog";
import { mascotDataUri } from "./mascot";
import { between, createRng, hashString, logNormal, pick, seededAddress, seededHash } from "./random";

export type Archetype = "rocket" | "pumpdump" | "steady" | "fading" | "sleepy" | "newborn";

export type PreviewQuote = MarketQuote;

/** Estimated cost of the ETH to pair-asset hop for pay-with-ETH buys. */
export const ROUTE_COST_BPS = 30;

export type { LaunchInput } from "@/lib/market/Market";

/** Preview transactions fail exactly like live ones. */
export const PreviewTxError = TxError;

interface SimCoin {
  coin: Coin;
  x: number;
  y: number;
  k: number;
  x0: number;
  trades: Trade[];
  balances: Map<Address, number>;
  burned: number;
  archetype: Archetype;
  peak: number;
  comments: Comment[];
  floorAdds: number;
  nextBuybackUsd: number;
}

interface UserState {
  balances: Map<string, number>;
  costBasisUsd: Map<Address, number>;
  holderRewards: Map<Address, number>;
  referralRewards: Map<Address, number>;
  claimedCreator: Map<Address, number>;
  createdCoins: Set<Address>;
}

const LIVE_TICK_MS = 1500;
const LAUNCH_EVERY_TICKS = 32;
const EPOCH_MS = 60 * 60 * 1000;
const MAX_TRADES_PER_COIN = 1500;
const ACTIVITY_LIMIT = 120;
const BUYBACK_THRESHOLD_USD = 25;
const DEFAULT_REFERRAL_RATE = 0.3;

const LIVE_ADJECTIVES = ["Tiny", "Based", "Lucky", "Sleepy", "Turbo", "Cosmic", "Neon", "Velvet", "Frosty", "Glitchy", "Mellow", "Spicy", "Fuzzy", "Royal", "Sunny"];
const LIVE_ANIMALS = ["Otter", "Yak", "Gecko", "Badger", "Heron", "Walrus", "Ferret", "Quokka", "Lynx", "Puffin", "Tapir", "Ibis", "Marmot", "Axolotl", "Narwhal"];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function targetMultiplier(archetype: Archetype, peak: number, t: number): number {
  const p = Math.max(1.05, peak);
  switch (archetype) {
    case "rocket":
      return 1 + (p - 1) * t ** 0.8;
    case "pumpdump":
      return t < 0.35 ? 1 + (p - 1) * (t / 0.35) ** 1.2 : Math.max(1.2, p * (1 - 0.65 * ((t - 0.35) / 0.65) ** 0.7));
    case "steady":
      return 1 + (p - 1) * t;
    case "fading":
      return t < 0.15 ? 1 + (p - 1) * (t / 0.15) : Math.max(1.2, p - (p - 1.3) * ((t - 0.15) / 0.85) ** 0.6);
    case "sleepy":
      return 1 + (p - 1) * t * t;
    case "newborn":
      return 1 + (p - 1) * t;
  }
}

function emptyStats(now: number): ModeStats {
  return {
    feesTotalQuote: 0,
    platformQuote: 0,
    referralQuote: 0,
    creatorEarnedQuote: 0,
    creatorClaimedQuote: 0,
    burnedCoins: 0,
    burnBudgetQuote: 0,
    buybacks: 0,
    holdersPaidQuote: 0,
    epochPendingQuote: 0,
    nextEpochAt: Math.ceil(now / EPOCH_MS) * EPOCH_MS,
    epochs: 0,
    floorQuote: 0,
    floorPriceUsd: 0,
  };
}

export class PreviewMarket implements Market {
  readonly kind = "preview" as const;
  private readonly coins = new Map<Address, SimCoin>();
  private readonly order: Address[] = [];
  private activity: ActivityItem[] = [];
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private liveNameIndex = 0;
  private readonly creators: Array<{ address: Address; name: string; joinedAt: number }> = [];
  private readonly users = new Map<Address, UserState>();
  private settings: LaunchSettings = { ...DEFAULT_SETTINGS };
  private hiddenCoins = new Set<Address>();
  private featuredCoins = new Set<Address>();
  private banner = "";
  private readonly rng: () => number;

  constructor(
    private readonly options: { now: number; seed?: number; empty?: boolean; protectionDemo?: boolean },
  ) {
    this.rng = createRng(options.seed ?? 20261001);
    this.buildCreators();
    if (!options.empty) this.buildHistory();
  }

  /* ---------------------------------------------------------------- store */

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = () => this.version;

  private emit() {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  start() {
    if (this.timer || this.options.empty) return;
    this.timer = setInterval(() => this.tick(Date.now()), LIVE_TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ------------------------------------------------------------- readers */

  listCoins(includeHidden = false): Coin[] {
    const result: Coin[] = [];
    for (const address of this.order) {
      const sim = this.coins.get(address);
      if (sim && (includeHidden || !this.hiddenCoins.has(address))) result.push(sim.coin);
    }
    return result;
  }

  getCoin(address: string): Coin | undefined {
    return this.findSim(address)?.coin;
  }

  getTrades(address: string, limit = 100): Trade[] {
    const sim = this.findSim(address);
    if (!sim) return [];
    return sim.trades.slice(-limit).reverse();
  }

  getComments(address: string): Comment[] {
    return this.findSim(address)?.comments.slice().reverse() ?? [];
  }

  getActivity(limit = 40): ActivityItem[] {
    return this.activity.slice(0, limit).filter((item) => !this.hiddenCoins.has(item.coin));
  }

  getSettings(): LaunchSettings {
    return this.settings;
  }

  async updateSettings(next: LaunchSettings) {
    this.settings = { ...next, enabledModes: [...next.enabledModes], enabledQuoteKinds: [...next.enabledQuoteKinds] };
    this.emit();
  }

  listQuotes(): QuoteAsset[] {
    return QUOTES;
  }

  getStatus(): MarketStatus {
    return { state: "ready" };
  }

  getModeration() {
    return { hidden: [...this.hiddenCoins], featured: [...this.featuredCoins], banner: this.banner };
  }

  async setHidden(address: Address, hidden: boolean) {
    if (hidden) this.hiddenCoins.add(address);
    else this.hiddenCoins.delete(address);
    const sim = this.coins.get(address);
    if (sim) sim.coin = { ...sim.coin, hidden };
    this.emit();
  }

  async setFeatured(address: Address, featured: boolean) {
    if (featured) this.featuredCoins.add(address);
    else this.featuredCoins.delete(address);
    const sim = this.coins.get(address);
    if (sim) sim.coin = { ...sim.coin, featured };
    this.emit();
  }

  async setBanner(text: string) {
    this.banner = text;
    this.emit();
  }

  getCandles(address: string, interval: CandleInterval, metric: "price" | "mcap" = "price"): Candle[] {
    const sim = this.findSim(address);
    if (!sim) return [];
    const now = Date.now();
    const seconds = interval;
    const maxBuckets = 320;
    const createdSec = Math.floor(sim.coin.createdAt / 1000);
    const startSec = Math.max(createdSec - (createdSec % seconds), Math.floor(now / 1000 / seconds) * seconds - seconds * (maxBuckets - 1));
    const endSec = Math.floor(now / 1000 / seconds) * seconds;
    const openingValue = metric === "price" ? sim.coin.openingMarketCapUsd / COIN_SUPPLY_HUMAN : sim.coin.openingMarketCapUsd;

    const candles: Candle[] = [];
    let previousClose = openingValue;
    let tradeIndex = 0;
    const trades = sim.trades;
    // Close of everything before the window.
    while (tradeIndex < trades.length && (trades[tradeIndex] as Trade).ts / 1000 < startSec) {
      const trade = trades[tradeIndex] as Trade;
      previousClose = metric === "price" ? trade.priceUsd : trade.marketCapUsd;
      tradeIndex += 1;
    }
    for (let bucket = startSec; bucket <= endSec; bucket += seconds) {
      let open = previousClose;
      let high = previousClose;
      let low = previousClose;
      let close = previousClose;
      let volume = 0;
      let first = true;
      while (tradeIndex < trades.length && (trades[tradeIndex] as Trade).ts / 1000 < bucket + seconds) {
        const trade = trades[tradeIndex] as Trade;
        const value = metric === "price" ? trade.priceUsd : trade.marketCapUsd;
        if (first) {
          open = previousClose;
          first = false;
        }
        high = Math.max(high, value);
        low = Math.min(low, value);
        close = value;
        volume += trade.quoteAmount * sim.coin.quote.usdPrice;
        tradeIndex += 1;
      }
      candles.push({ time: bucket, open, high, low, close, volume });
      previousClose = close;
    }
    return candles;
  }

  getHolders(address: string, viewer?: Address, limit = 25): Holder[] {
    const sim = this.findSim(address);
    if (!sim) return [];
    const holders: Holder[] = [
      { address: sim.coin.address, balance: sim.y, pct: sim.y / COIN_SUPPLY_HUMAN, label: "pool" },
    ];
    if (sim.burned > 0) holders.push({ address: DEAD_ADDRESS, balance: sim.burned, pct: sim.burned / COIN_SUPPLY_HUMAN, label: "burn" });
    const wallets = [...sim.balances.entries()]
      .filter(([, balance]) => balance >= 1)
      .sort((a, b) => b[1] - a[1]);
    for (const [wallet, balance] of wallets) {
      holders.push({
        address: wallet,
        balance,
        pct: balance / COIN_SUPPLY_HUMAN,
        label: wallet === sim.coin.creator ? "creator" : viewer && wallet === viewer ? "you" : undefined,
      });
    }
    return holders.slice(0, limit);
  }

  getCreators(): CreatorProfile[] {
    return this.creators.map((creator) => this.creatorProfile(creator.address)).filter((p): p is CreatorProfile => Boolean(p));
  }

  creatorProfile(address: string): CreatorProfile | undefined {
    const lower = address.toLowerCase();
    const creator = this.creators.find((entry) => entry.address.toLowerCase() === lower);
    const coins = this.order.filter((coin) => this.coins.get(coin)?.coin.creator.toLowerCase() === lower);
    if (!creator && coins.length === 0) return undefined;
    let earnedUsd = 0;
    let volumeUsd = 0;
    for (const coinAddress of coins) {
      const sim = this.coins.get(coinAddress);
      if (!sim) continue;
      earnedUsd += sim.coin.stats.creatorEarnedQuote * sim.coin.quote.usdPrice;
      volumeUsd += sim.coin.volumeTotalUsd;
    }
    return {
      address: (creator?.address ?? address) as Address,
      name: creator?.name ?? "",
      coins,
      earnedUsd,
      volumeUsd,
      joinedAt: creator?.joinedAt ?? Date.now(),
    };
  }

  /* ---------------------------------------------------------- user state */

  ensureUser(address: Address, preset: "default" | "poor" | "creator" = "default"): UserState {
    let user = this.users.get(address);
    if (user) return user;
    user = {
      balances: new Map(),
      costBasisUsd: new Map(),
      holderRewards: new Map(),
      referralRewards: new Map(),
      claimedCreator: new Map(),
      createdCoins: new Set(),
    };
    if (preset === "poor") {
      user.balances.set("ETH", 0.0004);
      user.balances.set("USDC", 1.2);
    } else {
      user.balances.set("ETH", 2.4816);
      user.balances.set("USDC", 4_250);
      user.balances.set(PREVIEW_STOCKS[0]?.symbol ?? "NVDAc", 3.2);
      user.balances.set(PREVIEW_STOCKS[2]?.symbol ?? "TSLAc", 1.1);
    }
    this.users.set(address, user);
    this.seedUserPositions(address, user, preset === "creator");
    this.emit();
    return user;
  }

  getQuoteBalance(address: Address, symbol: string): number {
    return this.users.get(address)?.balances.get(symbol) ?? 0;
  }

  getCoinBalance(address: Address, coin: string): number {
    return this.findSim(coin)?.balances.get(address) ?? 0;
  }

  getPositions(address: Address): Position[] {
    const user = this.users.get(address);
    const positions: Position[] = [];
    for (const coinAddress of this.order) {
      const sim = this.coins.get(coinAddress);
      if (!sim) continue;
      const balance = sim.balances.get(address) ?? 0;
      if (balance < 1) continue;
      const valueUsd = balance * sim.coin.priceUsd;
      const costBasisUsd = user?.costBasisUsd.get(coinAddress) ?? valueUsd;
      positions.push({ coin: coinAddress, balance, costBasisUsd, valueUsd, pnlUsd: valueUsd - costBasisUsd });
    }
    return positions.sort((a, b) => b.valueUsd - a.valueUsd);
  }

  getClaimables(address: Address): Claimable[] {
    const user = this.users.get(address);
    if (!user) return [];
    const items: Claimable[] = [];
    for (const coinAddress of this.order) {
      const sim = this.coins.get(coinAddress);
      if (!sim) continue;
      const { quote } = sim.coin;
      if (sim.coin.creator === address) {
        const claimable = sim.coin.stats.creatorEarnedQuote - sim.coin.stats.creatorClaimedQuote;
        if (claimable > 0) items.push({ coin: coinAddress, kind: "creator", amountQuote: claimable, quoteSymbol: quote.symbol, amountUsd: claimable * quote.usdPrice });
      }
      const holder = user.holderRewards.get(coinAddress) ?? 0;
      if (holder > 0) items.push({ coin: coinAddress, kind: "holders", amountQuote: holder, quoteSymbol: quote.symbol, amountUsd: holder * quote.usdPrice, epoch: sim.coin.stats.epochs });
      const referral = user.referralRewards.get(coinAddress) ?? 0;
      if (referral > 0) items.push({ coin: coinAddress, kind: "referral", amountQuote: referral, quoteSymbol: quote.symbol, amountUsd: referral * quote.usdPrice });
    }
    return items.sort((a, b) => b.amountUsd - a.amountUsd);
  }

  async claim(address: Address, items: Claimable[], outcome: "ok" | "rejected" | "reverted" = "ok"): Promise<`0x${string}`> {
    await wait(700);
    if (outcome === "rejected") throw new TxError("You rejected the request in your wallet.", "rejected");
    await wait(900);
    if (outcome === "reverted") throw new TxError("The claim did not go through. Nothing was paid out. Try again.", "reverted");
    const user = this.ensureUser(address);
    for (const item of items) {
      const sim = this.coins.get(item.coin);
      if (!sim) continue;
      if (item.kind === "creator") {
        sim.coin = { ...sim.coin, stats: { ...sim.coin.stats, creatorClaimedQuote: sim.coin.stats.creatorEarnedQuote } };
      } else if (item.kind === "holders") {
        user.holderRewards.delete(item.coin);
      } else {
        user.referralRewards.delete(item.coin);
      }
      user.balances.set(item.quoteSymbol, (user.balances.get(item.quoteSymbol) ?? 0) + item.amountQuote);
    }
    this.emit();
    return seededHash(Math.random);
  }

  /* -------------------------------------------------------------- trading */

  currentFeeBps(sim: SimCoin, now: number, isFirstBuy = false): number {
    if (isFirstBuy) return sim.coin.terms.feeBps;
    return launchFeeBps(
      sim.coin.terms.feeBps,
      { startBps: sim.coin.terms.snipeStartBps, durationSec: sim.coin.terms.snipeDurationSec },
      (now - sim.coin.createdAt) / 1000,
    );
  }

  /** Converts an ETH amount into the coin's pair asset for pay-with-ETH buys. */
  routeEthToQuote(coinAddress: string, ethAmount: number): number {
    const sim = this.findSim(coinAddress);
    if (!sim || sim.coin.quote.symbol === "ETH") return ethAmount;
    return ((ethAmount * ETH.usdPrice) / sim.coin.quote.usdPrice) * (1 - ROUTE_COST_BPS / BPS);
  }

  quote(coinAddress: string, side: TradeSide, amountIn: number, now = Date.now(), payWithEth = false): PreviewQuote {
    const sim = this.findSim(coinAddress);
    const empty: PreviewQuote = { side, amountIn, amountOut: 0, feeQuote: 0, feeBps: 0, priceImpact: 0, priceAfterUsd: 0, marketCapAfterUsd: 0, ok: false };
    if (!sim) return { ...empty, reason: "Coin not found." };
    const feeBps = this.currentFeeBps(sim, now);
    if (!(amountIn > 0)) return { ...empty, feeBps };
    if (side === "buy" && payWithEth && sim.coin.quote.symbol !== "ETH") {
      const routed = this.routeEthToQuote(coinAddress, amountIn);
      return { ...this.quote(coinAddress, "buy", routed, now), amountIn, routedQuoteIn: routed };
    }
    const spot = sim.x / sim.y;
    const usd = sim.coin.quote.usdPrice;
    if (side === "buy") {
      const feeQuote = (amountIn * feeBps) / BPS;
      const net = amountIn - feeQuote;
      const x2 = sim.x + net;
      const y2 = sim.k / x2;
      const out = sim.y - y2;
      const avg = net / out;
      const priceAfter = x2 / y2;
      return {
        side,
        amountIn,
        amountOut: out,
        feeQuote,
        feeBps,
        priceImpact: Math.max(0, avg / spot - 1),
        priceAfterUsd: priceAfter * usd,
        marketCapAfterUsd: priceAfter * usd * (COIN_SUPPLY_HUMAN - sim.burned),
        ok: out > 0,
      };
    }
    const circulating = COIN_SUPPLY_HUMAN - sim.y - sim.burned;
    if (amountIn > circulating + 1e-6) return { ...empty, feeBps, reason: "More than the pool can take back." };
    const y2 = sim.y + amountIn;
    const x2 = Math.max(sim.x0, sim.k / y2);
    const gross = sim.x - x2;
    const feeQuote = (gross * feeBps) / BPS;
    const out = gross - feeQuote;
    const avg = gross / amountIn;
    const priceAfter = x2 / y2;
    return {
      side,
      amountIn,
      amountOut: out,
      feeQuote,
      feeBps,
      priceImpact: Math.max(0, 1 - avg / spot),
      priceAfterUsd: priceAfter * usd,
      marketCapAfterUsd: priceAfter * usd * (COIN_SUPPLY_HUMAN - sim.burned),
      ok: out > 0,
    };
  }

  async trade(
    user: Address,
    coinAddress: string,
    side: TradeSide,
    amountIn: number,
    minOut: number,
    options: { outcome?: "ok" | "rejected" | "reverted"; referrer?: Address; payWithEth?: boolean } = {},
  ): Promise<Trade> {
    const sim = this.findSim(coinAddress);
    if (!sim) throw new TxError("This coin is not available.", "reverted");
    const state = this.ensureUser(user);
    const quoteSymbol = sim.coin.quote.symbol;
    const routed = side === "buy" && options.payWithEth === true && quoteSymbol !== "ETH";
    const payingSymbol = routed ? "ETH" : side === "buy" ? quoteSymbol : sim.coin.symbol;
    const balance = side === "buy" ? state.balances.get(routed ? "ETH" : quoteSymbol) ?? 0 : sim.balances.get(user) ?? 0;
    if (amountIn > balance + 1e-12) {
      throw new TxError(`Not enough ${payingSymbol} in your wallet.`, "insufficient");
    }
    await wait(650);
    if (options.outcome === "rejected") throw new TxError("You rejected the request in your wallet.", "rejected");
    await wait(900);
    if (options.outcome === "reverted") {
      throw new TxError("The price moved more than your slippage allows, so the trade was cancelled. Nothing was spent except network fee.", "reverted");
    }
    const quoted = this.quote(coinAddress, side, amountIn, Date.now(), routed);
    if (quoted.amountOut < minOut) {
      throw new TxError("The price moved more than your slippage allows, so the trade was cancelled.", "reverted");
    }
    const swapIn = routed ? this.routeEthToQuote(coinAddress, amountIn) : amountIn;
    const trade = this.applyTrade(sim, side, user, swapIn, Date.now(), { referred: Boolean(options.referrer) });
    if (side === "buy") {
      const spentSymbol = routed ? "ETH" : quoteSymbol;
      const spentUsd = routed ? amountIn * ETH.usdPrice : amountIn * sim.coin.quote.usdPrice;
      state.balances.set(spentSymbol, (state.balances.get(spentSymbol) ?? 0) - amountIn);
      state.costBasisUsd.set(sim.coin.address, (state.costBasisUsd.get(sim.coin.address) ?? 0) + spentUsd);
    } else {
      state.balances.set(quoteSymbol, (state.balances.get(quoteSymbol) ?? 0) + trade.quoteAmount);
      const before = balance;
      const basis = state.costBasisUsd.get(sim.coin.address) ?? 0;
      state.costBasisUsd.set(sim.coin.address, before > 0 ? basis * Math.max(0, (before - amountIn) / before) : 0);
    }
    this.refreshCoin(sim, Date.now());
    this.emit();
    return trade;
  }

  async launch(user: Address, input: LaunchInput, outcome: "ok" | "rejected" | "reverted" = "ok"): Promise<Coin> {
    // The same checks the factory enforces on chain, so the UI cannot drift from them.
    if (this.settings.launchesPaused) throw new TxError("New launches are paused right now. Existing coins trade as normal.", "reverted");
    if (!this.settings.enabledModes.includes(input.mode)) throw new TxError("That fee destination is not available right now.", "reverted");
    if (!this.settings.enabledQuoteKinds.includes(input.quote.kind)) throw new TxError("That pair is not available right now.", "reverted");
    if (input.feeBps < this.settings.feeMinBps || input.feeBps > this.settings.feeMaxBps) {
      throw new TxError("The trading fee is outside the allowed range.", "reverted");
    }
    if (input.mode !== "creator" && (input.creatorKeepBps < 0 || input.creatorKeepBps > this.settings.creatorKeepMaxBps)) {
      throw new TxError("The creator share is above the allowed limit.", "reverted");
    }
    const state = this.ensureUser(user);
    const quoteBalance = state.balances.get(input.quote.symbol) ?? 0;
    if (input.firstBuyQuote > quoteBalance + 1e-12) {
      throw new TxError(`Not enough ${input.quote.symbol} for the first buy.`, "insufficient");
    }
    await wait(700);
    if (outcome === "rejected") throw new TxError("You rejected the request in your wallet.", "rejected");
    await wait(1400);
    if (outcome === "reverted") throw new TxError("The launch did not go through and nothing was created. You were only charged network fee.", "reverted");
    const now = Date.now();
    const sim = this.createSim({
      address: seededAddress(Math.random, "b20"),
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      image: input.image,
      links: input.links,
      creator: user,
      createdAt: now,
      quote: input.quote,
      terms: {
        feeBps: input.feeBps,
        mode: input.mode,
        creatorKeepBps: input.mode === "creator" ? 0 : input.creatorKeepBps,
        platformShareBps: this.settings.platformShareBps,
        referralShareBps: this.settings.referralShareBps,
        snipeStartBps: this.settings.snipeStartBps,
        snipeDurationSec: this.settings.snipeDurationSec,
      },
      openingFdvUsd: this.settings.openingFdvUsd,
      archetype: "newborn",
      peak: 3,
      seed: hashString(input.name + now),
    });
    state.createdCoins.add(sim.coin.address);
    if (input.firstBuyQuote > 0) {
      this.applyTrade(sim, "buy", user, input.firstBuyQuote, now, { firstBuy: true });
      state.balances.set(input.quote.symbol, quoteBalance - input.firstBuyQuote);
      state.costBasisUsd.set(sim.coin.address, input.firstBuyQuote * input.quote.usdPrice);
    }
    this.refreshCoin(sim, now);
    this.pushActivity({ id: `launch-${sim.coin.address}`, kind: "launch", coin: sim.coin.address, ts: now });
    this.emit();
    return sim.coin;
  }

  /**
   * Posts a comment. Phase 3 replaces this with a wallet-signed post (single
   * use nonce) stored by the API; the rules here mirror that endpoint.
   */
  async addComment(author: Address, coinAddress: string, body: string): Promise<Comment> {
    const sim = this.findSim(coinAddress);
    if (!sim) throw new TxError("This coin is not available.", "reverted");
    const text = body.replace(/\s+/g, " ").trim();
    if (!text) throw new TxError("Write something first.", "reverted");
    if (text.length > 280) throw new TxError("Comments can be up to 280 characters.", "reverted");
    await wait(450);
    const comment: Comment = {
      id: `${sim.coin.address}-u${Date.now()}`,
      coin: sim.coin.address,
      author,
      body: text,
      ts: Date.now(),
      isCreator: author === sim.coin.creator,
    };
    sim.comments.push(comment);
    this.emit();
    return comment;
  }

  /** Every trade a wallet made, newest first (profile activity). */
  getTradesByTrader(trader: string, limit = 50): Trade[] {
    const lower = trader.toLowerCase();
    const result: Trade[] = [];
    for (const sim of this.coins.values()) {
      for (const trade of sim.trades) if (trade.trader.toLowerCase() === lower) result.push(trade);
    }
    return result.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /** Finds a coin matching a predicate, used by preview scenarios. */
  findCoin(predicate: (coin: Coin) => boolean): Coin | undefined {
    return this.listCoins().find(predicate);
  }

  /* ------------------------------------------------------------ internals */

  private findSim(address: string): SimCoin | undefined {
    const direct = this.coins.get(address as Address);
    if (direct) return direct;
    const lower = address.toLowerCase();
    for (const [key, sim] of this.coins) if (key.toLowerCase() === lower) return sim;
    return undefined;
  }

  private buildCreators() {
    const rng = createRng(77);
    for (const name of PREVIEW_CREATOR_NAMES) {
      this.creators.push({
        address: seededAddress(rng),
        name,
        joinedAt: this.options.now - Math.floor(between(rng, 5, 120)) * 86_400_000,
      });
    }
  }

  private createSim(input: {
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
    openingFdvUsd: number;
    archetype: Archetype;
    peak: number;
    seed: number;
  }): SimCoin {
    const x0 = input.openingFdvUsd / input.quote.usdPrice;
    const y = COIN_SUPPLY_HUMAN;
    const priceQuote = x0 / y;
    const coin: Coin = {
      address: input.address,
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      image: input.image,
      links: input.links,
      creator: input.creator,
      createdAt: input.createdAt,
      quote: input.quote,
      terms: input.terms,
      priceQuote,
      priceUsd: priceQuote * input.quote.usdPrice,
      marketCapUsd: input.openingFdvUsd,
      fdvUsd: input.openingFdvUsd,
      openingMarketCapUsd: input.openingFdvUsd,
      athMarketCapUsd: input.openingFdvUsd,
      liquidityUsd: input.openingFdvUsd,
      volume24hUsd: 0,
      volumeTotalUsd: 0,
      change5m: 0,
      change1h: 0,
      change24h: 0,
      holders: 0,
      circulating: 0,
      buys24h: 0,
      sells24h: 0,
      lastTradeAt: input.createdAt,
      sparkline: [],
      stats: emptyStats(input.createdAt),
      momentum: 0,
      devHoldsPct: 0,
      devSold: false,
      top10Pct: 0,
      snipers: 0,
      sameBlockBuys: 0,
      milestonesReached: 0,
    };
    const sim: SimCoin = {
      coin,
      x: x0,
      y,
      k: x0 * y,
      x0,
      trades: [],
      balances: new Map(),
      burned: 0,
      archetype: input.archetype,
      peak: input.peak,
      comments: [],
      floorAdds: 0,
      nextBuybackUsd: BUYBACK_THRESHOLD_USD,
    };
    this.coins.set(coin.address, sim);
    this.order.unshift(coin.address);
    return sim;
  }

  /** Executes one trade through the curve and books every fee share. */
  private applyTrade(
    sim: SimCoin,
    side: TradeSide,
    trader: Address,
    amountIn: number,
    ts: number,
    flags: { firstBuy?: boolean; referred?: boolean; rng?: () => number } = {},
  ): Trade {
    const rand = flags.rng ?? Math.random;
    const feeBps = this.currentFeeBps(sim, ts, flags.firstBuy);
    const mcapBefore = this.marketCapUsd(sim);
    let quoteAmount: number;
    let coinAmount: number;
    let feeQuote: number;

    if (side === "buy") {
      feeQuote = (amountIn * feeBps) / BPS;
      const x2 = sim.x + (amountIn - feeQuote);
      const y2 = sim.k / x2;
      coinAmount = sim.y - y2;
      quoteAmount = amountIn;
      sim.x = x2;
      sim.y = y2;
      sim.balances.set(trader, (sim.balances.get(trader) ?? 0) + coinAmount);
    } else {
      const y2 = sim.y + amountIn;
      const x2 = Math.max(sim.x0, sim.k / y2);
      const gross = sim.x - x2;
      feeQuote = (gross * feeBps) / BPS;
      quoteAmount = gross - feeQuote;
      coinAmount = amountIn;
      sim.x = x2;
      sim.y = y2;
      const left = (sim.balances.get(trader) ?? 0) - amountIn;
      if (left < 1) sim.balances.delete(trader);
      else sim.balances.set(trader, left);
      if (trader === sim.coin.creator) sim.coin = { ...sim.coin, devSold: true };
    }

    const hasReferrer = flags.referred ?? rand() < DEFAULT_REFERRAL_RATE;
    this.bookFee(sim, feeQuote, hasReferrer, ts);

    const priceQuote = sim.x / sim.y;
    const trade: Trade = {
      id: `${sim.coin.address}-${ts}-${sim.trades.length}`,
      coin: sim.coin.address,
      ts,
      side,
      trader,
      quoteAmount,
      coinAmount,
      priceUsd: priceQuote * sim.coin.quote.usdPrice,
      marketCapUsd: this.marketCapUsd(sim),
      feeQuote,
      feeBps,
      txHash: seededHash(rand),
      isCreator: trader === sim.coin.creator,
      inProtection: !flags.firstBuy && (ts - sim.coin.createdAt) / 1000 < sim.coin.terms.snipeDurationSec,
    };
    sim.trades.push(trade);
    if (sim.trades.length > MAX_TRADES_PER_COIN) sim.trades.splice(0, sim.trades.length - MAX_TRADES_PER_COIN);

    const crossed = crossedMilestone(mcapBefore, trade.marketCapUsd);
    if (crossed && ts > this.options.now - 6 * 3_600_000) {
      this.pushActivity({ id: `ms-${sim.coin.address}-${crossed}`, kind: "milestone", coin: sim.coin.address, ts, milestone: crossed });
    }
    if (ts >= this.options.now - 120_000) {
      this.pushActivity({ id: trade.id, kind: "trade", coin: sim.coin.address, ts, trade });
    }
    return trade;
  }

  private bookFee(sim: SimCoin, feeQuote: number, hasReferrer: boolean, ts: number) {
    if (feeQuote <= 0) return;
    const terms = sim.coin.terms;
    const shares = feeShareFractions(
      { mode: terms.mode, platformShareBps: terms.platformShareBps, referralShareBps: terms.referralShareBps, creatorKeepBps: terms.creatorKeepBps },
      hasReferrer,
    );
    const stats = { ...sim.coin.stats };
    stats.feesTotalQuote += feeQuote;
    stats.platformQuote += feeQuote * shares.platform;
    stats.referralQuote += feeQuote * shares.referral;
    stats.creatorEarnedQuote += feeQuote * shares.creator;
    const destination = feeQuote * shares.destination;
    if (terms.mode === "burn") stats.burnBudgetQuote += destination;
    if (terms.mode === "holders") stats.epochPendingQuote += destination;
    if (terms.mode === "floor") stats.floorQuote += destination;
    sim.coin = { ...sim.coin, stats };

    if (hasReferrer) {
      // Some referred trades in preview are attributed to demo wallets that shared links.
      for (const [address, user] of this.users) {
        if (Math.random() < 0.05) user.referralRewards.set(sim.coin.address, (user.referralRewards.get(sim.coin.address) ?? 0) + feeQuote * shares.referral);
        void address;
      }
    }

    if (terms.mode === "burn" && stats.burnBudgetQuote * sim.coin.quote.usdPrice >= sim.nextBuybackUsd) {
      this.executeBuyback(sim, ts);
    }
    if (terms.mode === "floor") {
      sim.floorAdds += 1;
      this.updateFloor(sim);
      if (sim.floorAdds % 25 === 0 && ts >= this.options.now - 600_000) {
        this.pushActivity({ id: `floor-${sim.coin.address}-${ts}`, kind: "floor", coin: sim.coin.address, ts, amountQuote: sim.coin.stats.floorQuote });
      }
    }
  }

  private executeBuyback(sim: SimCoin, ts: number) {
    const budget = sim.coin.stats.burnBudgetQuote;
    if (budget <= 0) return;
    const x2 = sim.x + budget;
    const y2 = sim.k / x2;
    const bought = sim.y - y2;
    sim.x = x2;
    sim.y = y2;
    sim.burned += bought;
    // Deterministic jitter (golden-ratio sequence) keeps the preview reproducible.
    const jitter = ((sim.coin.stats.buybacks + 1) * 0.6180339887) % 1;
    sim.nextBuybackUsd = BUYBACK_THRESHOLD_USD * (0.8 + 0.8 * jitter);
    sim.coin = {
      ...sim.coin,
      stats: { ...sim.coin.stats, burnBudgetQuote: 0, burnedCoins: sim.burned, buybacks: sim.coin.stats.buybacks + 1 },
    };
    if (ts >= this.options.now - 600_000) {
      this.pushActivity({ id: `burn-${sim.coin.address}-${ts}`, kind: "burn", coin: sim.coin.address, ts, amountQuote: budget, amountCoins: bought });
    }
  }

  private updateFloor(sim: SimCoin) {
    const circulating = COIN_SUPPLY_HUMAN - sim.y - sim.burned;
    const floorPriceUsd = circulating > 1 ? (sim.coin.stats.floorQuote / circulating) * sim.coin.quote.usdPrice : 0;
    sim.coin = { ...sim.coin, stats: { ...sim.coin.stats, floorPriceUsd } };
  }

  /** Pays out holder epochs that have ended by `now`. */
  private settleEpochs(sim: SimCoin, now: number) {
    if (sim.coin.terms.mode !== "holders") return;
    let stats = sim.coin.stats;
    while (stats.nextEpochAt <= now) {
      const pending = stats.epochPendingQuote;
      if (pending > 0) {
        const circulating = Math.max(1, COIN_SUPPLY_HUMAN - sim.y - sim.burned);
        for (const [address, user] of this.users) {
          const held = sim.balances.get(address) ?? 0;
          if (held > 0) user.holderRewards.set(sim.coin.address, (user.holderRewards.get(sim.coin.address) ?? 0) + pending * (held / circulating));
        }
        if (stats.nextEpochAt >= this.options.now - 600_000) {
          this.pushActivity({ id: `payout-${sim.coin.address}-${stats.nextEpochAt}`, kind: "payout", coin: sim.coin.address, ts: stats.nextEpochAt, amountQuote: pending });
        }
      }
      stats = {
        ...stats,
        holdersPaidQuote: stats.holdersPaidQuote + pending,
        epochPendingQuote: 0,
        epochs: stats.epochs + (pending > 0 ? 1 : 0),
        nextEpochAt: stats.nextEpochAt + EPOCH_MS,
      };
    }
    sim.coin = { ...sim.coin, stats };
  }

  private marketCapUsd(sim: SimCoin) {
    return (sim.x / sim.y) * sim.coin.quote.usdPrice * (COIN_SUPPLY_HUMAN - sim.burned);
  }

  private priceAt(sim: SimCoin, ts: number): number {
    let price = sim.coin.openingMarketCapUsd / COIN_SUPPLY_HUMAN;
    if (ts < sim.coin.createdAt) return price;
    for (const trade of sim.trades) {
      if (trade.ts > ts) break;
      price = trade.priceUsd;
    }
    return price;
  }

  /** Recomputes every derived field of a coin from its trades and balances. */
  private refreshCoin(sim: SimCoin, now: number) {
    this.settleEpochs(sim, now);
    const priceQuote = sim.x / sim.y;
    const usd = sim.coin.quote.usdPrice;
    const priceUsd = priceQuote * usd;
    const marketCapUsd = this.marketCapUsd(sim);
    const dayAgo = now - 86_400_000;
    let volume24h = 0;
    let volumeTotal = 0;
    let volume1h = 0;
    let buys = 0;
    let sells = 0;
    let recent = 0;
    let ath = sim.coin.openingMarketCapUsd;
    const sniperWallets = new Set<Address>();
    const blockWallets = new Map<number, Set<Address>>();
    for (const trade of sim.trades) {
      const valueUsd = trade.quoteAmount * usd;
      volumeTotal += valueUsd;
      ath = Math.max(ath, trade.marketCapUsd);
      if (trade.ts >= dayAgo) {
        volume24h += valueUsd;
        if (trade.side === "buy") buys += 1;
        else sells += 1;
      }
      if (trade.ts >= now - 3_600_000) volume1h += valueUsd;
      if (trade.ts >= now - 900_000) recent += 1;
      if (trade.inProtection && trade.side === "buy" && !trade.isCreator) sniperWallets.add(trade.trader);
      if (trade.side === "buy" && trade.ts - sim.coin.createdAt < 60_000) {
        const block = Math.floor(trade.ts / 2000);
        const set = blockWallets.get(block) ?? new Set<Address>();
        set.add(trade.trader);
        blockWallets.set(block, set);
      }
    }
    let sameBlockBuys = 0;
    for (const set of blockWallets.values()) if (set.size > 1) sameBlockBuys += set.size;

    const sparkStart = Math.max(sim.coin.createdAt, dayAgo);
    const sparkline: number[] = [];
    const steps = 47;
    let tradeIndex = 0;
    let lastPrice = sim.coin.openingMarketCapUsd / COIN_SUPPLY_HUMAN;
    for (let step = 0; step <= steps; step += 1) {
      const at = sparkStart + ((now - sparkStart) * step) / steps;
      while (tradeIndex < sim.trades.length && (sim.trades[tradeIndex] as Trade).ts <= at) {
        lastPrice = (sim.trades[tradeIndex] as Trade).priceUsd;
        tradeIndex += 1;
      }
      sparkline.push(lastPrice);
    }

    const wallets = [...sim.balances.entries()].filter(([, balance]) => balance >= 1);
    const sorted = wallets.map(([, balance]) => balance).sort((a, b) => b - a);
    const top10 = sorted.slice(0, 10).reduce((sum, value) => sum + value, 0);
    const change = (ago: number) => {
      const then = this.priceAt(sim, now - ago);
      return then > 0 ? priceUsd / then - 1 : 0;
    };
    const change1h = change(3_600_000);
    const ageHours = Math.max(0.05, (now - sim.coin.createdAt) / 3_600_000);
    const freshness = ageHours < 1 ? 1.6 : ageHours < 6 ? 1.2 : 1;
    const momentum = (volume1h * (1 + clamp(change1h, -0.6, 3)) + recent * 40) * freshness;
    const liquidityUsd = (sim.x - sim.x0 + sim.x) * usd;

    sim.coin = {
      ...sim.coin,
      priceQuote,
      priceUsd,
      marketCapUsd,
      fdvUsd: priceUsd * COIN_SUPPLY_HUMAN,
      athMarketCapUsd: Math.max(ath, marketCapUsd),
      liquidityUsd,
      volume24hUsd: volume24h,
      volumeTotalUsd: volumeTotal,
      change5m: change(300_000),
      change1h,
      change24h: change(86_400_000),
      holders: wallets.length,
      circulating: Math.max(0, COIN_SUPPLY_HUMAN - sim.y - sim.burned),
      buys24h: buys,
      sells24h: sells,
      lastTradeAt: sim.trades.length > 0 ? (sim.trades[sim.trades.length - 1] as Trade).ts : sim.coin.createdAt,
      sparkline,
      momentum,
      devHoldsPct: (sim.balances.get(sim.coin.creator) ?? 0) / COIN_SUPPLY_HUMAN,
      top10Pct: top10 / COIN_SUPPLY_HUMAN,
      snipers: sniperWallets.size,
      sameBlockBuys,
      milestonesReached: milestoneProgress(marketCapUsd, sim.coin.openingMarketCapUsd).reached,
      stats: { ...sim.coin.stats, burnedCoins: sim.burned },
    };
    if (sim.coin.terms.mode === "floor") this.updateFloor(sim);
  }

  private pushActivity(item: ActivityItem) {
    if (this.activity.some((existing) => existing.id === item.id)) return;
    this.activity.unshift(item);
    this.activity.sort((a, b) => b.ts - a.ts);
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.length = ACTIVITY_LIMIT;
  }

  /** Chooses who trades: a new wallet, an existing holder, or the creator. */
  private pickTrader(sim: SimCoin, side: TradeSide, rng: () => number, pool: Address[]): Address | null {
    if (side === "sell") {
      const holders = [...sim.balances.entries()].filter(([address, balance]) => balance > 1 && (address !== sim.coin.creator || rng() < 0.08));
      if (holders.length === 0) return null;
      return (holders[Math.floor(rng() * holders.length)] as [Address, number])[0];
    }
    if (pool.length > 0 && rng() < 0.55) return pick(rng, pool);
    const fresh = seededAddress(rng);
    pool.push(fresh);
    return fresh;
  }

  private simulateTrade(sim: SimCoin, ts: number, rng: () => number, pool: Address[], lifetimeFraction: number) {
    const opening = sim.coin.openingMarketCapUsd;
    const target = opening * targetMultiplier(sim.archetype, sim.peak, clamp(lifetimeFraction, 0, 1));
    const current = this.marketCapUsd(sim);
    const pressure = Math.tanh(1.4 * Math.log(target / current));
    const buyProbability = clamp(0.5 + 0.36 * pressure, 0.14, 0.86);
    let side: TradeSide = rng() < buyProbability ? "buy" : "sell";
    const trader = this.pickTrader(sim, side, rng, pool);
    if (!trader) side = "buy";
    const who = trader ?? this.pickTrader(sim, "buy", rng, pool);
    if (!who) return;
    const usd = sim.coin.quote.usdPrice;
    if (side === "buy") {
      const median = clamp(current * 0.0028, 9, 30_000);
      const sizeUsd = clamp(logNormal(rng, median, 1.05), 1.5, current * 0.09);
      this.applyTrade(sim, "buy", who, sizeUsd / usd, ts, { rng });
    } else {
      const held = sim.balances.get(who) ?? 0;
      const fraction = rng() < 0.35 ? 1 : between(rng, 0.15, 0.85);
      const amount = held * fraction;
      if (amount < 1) return;
      this.applyTrade(sim, "sell", who, amount, ts, { rng });
    }
  }

  private buildHistory() {
    const now = this.options.now;
    const rng = this.rng;
    const catalog = PREVIEW_COINS.slice(0, PREVIEW_COINS.length - 6);
    // The last six catalog names are kept for live launches.
    this.liveNameIndex = PREVIEW_COINS.length - 6;

    catalog.forEach((entry, index) => {
      const coinSeed = hashString(entry.symbol) ^ (index * 2654435761);
      const crng = createRng(coinSeed);
      let archetype: Archetype;
      let ageMs: number;
      if (index < 3) {
        archetype = "rocket";
        ageMs = between(crng, 18, 90) * 3_600_000;
      } else if (index < 7) {
        archetype = "newborn";
        ageMs = index === 3 && this.options.protectionDemo ? 5_000 : between(crng, 25, 600) * 1000;
      } else {
        archetype = pick(crng, ["rocket", "pumpdump", "pumpdump", "steady", "steady", "steady", "fading", "fading", "sleepy", "sleepy"]);
        ageMs = Math.exp(between(crng, Math.log(25 * 60_000), Math.log(21 * 86_400_000)));
      }
      const peak =
        index === 0
          ? 1100
          : index === 1
            ? 420
            : index === 2
              ? 160
              : archetype === "rocket"
                ? Math.exp(between(crng, Math.log(20), Math.log(260)))
                : archetype === "pumpdump"
                  ? Math.exp(between(crng, Math.log(8), Math.log(120)))
                  : archetype === "steady"
                    ? Math.exp(between(crng, Math.log(2.5), Math.log(24)))
                    : archetype === "fading"
                      ? Math.exp(between(crng, Math.log(4), Math.log(40)))
                      : archetype === "newborn"
                        ? between(crng, 1.4, 4)
                        : between(crng, 1.05, 1.8);

      const quote = entry.stock ? pick(crng, PREVIEW_STOCKS) : crng() < 0.82 ? ETH : USDC;
      const mode: FeeMode = pick(crng, ["creator", "creator", "creator", "creator", "burn", "burn", "burn", "holders", "holders", "floor", "floor"]);
      const feeBps = pick(crng, [100, 100, 100, 100, 150, 200, 200, 250, 300, 500]);
      const creatorEntry = pick(crng, this.creators);
      const createdAt = now - Math.round(ageMs);
      const sim = this.createSim({
        address: seededAddress(crng, "b20"),
        name: entry.name,
        symbol: entry.symbol,
        description: entry.description,
        image: mascotDataUri(coinSeed),
        links: {
          x: crng() < 0.8 ? entry.symbol.toLowerCase() + "onbase" : undefined,
          telegram: crng() < 0.55 ? `${entry.symbol.toLowerCase()}_chat` : undefined,
          website: crng() < 0.35 ? `https://${entry.symbol.toLowerCase()}.fun` : undefined,
        },
        creator: creatorEntry.address,
        createdAt,
        quote,
        terms: {
          feeBps,
          mode,
          creatorKeepBps: mode === "creator" ? 0 : pick(crng, [0, 2000, 2500, 5000, 5000]),
          platformShareBps: DEFAULT_SETTINGS.platformShareBps,
          referralShareBps: DEFAULT_SETTINGS.referralShareBps,
          snipeStartBps: DEFAULT_SETTINGS.snipeStartBps,
          snipeDurationSec: DEFAULT_SETTINGS.snipeDurationSec,
        },
        openingFdvUsd: DEFAULT_SETTINGS.openingFdvUsd,
        archetype,
        peak,
        seed: coinSeed,
      });

      const pool: Address[] = [];
      // Creator's first buy in the launch transaction (exempt from protection).
      if (crng() < 0.7) {
        const firstBuyUsd = between(crng, 15, 260);
        this.applyTrade(sim, "buy", creatorEntry.address, firstBuyUsd / quote.usdPrice, createdAt, { firstBuy: true, rng: crng });
      }
      // A few bots try to snipe and pay the launch-protection fee.
      const snipers = archetype === "newborn" ? Math.floor(between(crng, 0, 3)) : Math.floor(between(crng, 0, 4));
      for (let s = 0; s < snipers && createdAt + 1000 * (s + 1) < now; s += 1) {
        const bot = seededAddress(crng);
        pool.push(bot);
        this.applyTrade(sim, "buy", bot, between(crng, 20, 180) / quote.usdPrice, createdAt + Math.round(between(crng, 1, 12) * 1000), { rng: crng });
      }

      const lifetimeHours = ageMs / 3_600_000;
      const baseCount =
        archetype === "rocket"
          ? between(crng, 380, 460)
          : archetype === "pumpdump"
            ? between(crng, 240, 380)
            : archetype === "steady"
              ? between(crng, 120, 260)
              : archetype === "fading"
                ? between(crng, 100, 220)
                : archetype === "sleepy"
                  ? between(crng, 8, 40)
                  : clamp(ageMs / 9000, 3, 50);
      const count = Math.round(lifetimeHours < 1 && archetype !== "newborn" ? baseCount * Math.max(0.3, lifetimeHours) : baseCount);
      const skew = archetype === "rocket" ? 0.85 : archetype === "pumpdump" ? 1.3 : archetype === "fading" ? 1.8 : 1;
      const times: number[] = [];
      const protectionEnd = createdAt + sim.coin.terms.snipeDurationSec * 1000;
      for (let i = 0; i < count; i += 1) {
        const u = crng() ** skew;
        const at = createdAt + u * (now - createdAt);
        if (at > protectionEnd || archetype === "newborn") times.push(Math.round(at));
      }
      times.sort((a, b) => a - b);
      for (const at of times) {
        this.simulateTrade(sim, Math.min(at, now), crng, pool, (at - createdAt) / Math.max(1, now - createdAt));
        if (sim.coin.terms.mode === "holders") this.settleEpochs(sim, at);
      }
      // Comments from holders.
      const commentCount = Math.floor(between(crng, 0, Math.min(9, 2 + times.length / 40)));
      for (let c = 0; c < commentCount; c += 1) {
        const author = pool.length > 0 ? pick(crng, pool) : creatorEntry.address;
        sim.comments.push({
          id: `${sim.coin.address}-c${c}`,
          coin: sim.coin.address,
          author: c === 0 && crng() < 0.4 ? creatorEntry.address : author,
          body: pick(crng, PREVIEW_COMMENTS),
          ts: createdAt + between(crng, 0.2, 1) * (now - createdAt),
          isCreator: false,
        });
      }
      sim.comments.sort((a, b) => a.ts - b.ts);
      sim.comments = sim.comments.map((comment) => ({ ...comment, isCreator: comment.author === creatorEntry.address }));
      this.refreshCoin(sim, now);
    });

    // Order: newest first, like a launch feed.
    this.order.sort((a, b) => (this.coins.get(b)?.coin.createdAt ?? 0) - (this.coins.get(a)?.coin.createdAt ?? 0));
    for (const address of this.order) {
      const sim = this.coins.get(address);
      if (sim && now - sim.coin.createdAt < 3_600_000) {
        this.pushActivity({ id: `launch-${address}`, kind: "launch", coin: address, ts: sim.coin.createdAt });
      }
    }
    void rng;
  }

  private seedUserPositions(address: Address, user: UserState, asCreator: boolean) {
    const rng = createRng(hashString(address));
    const candidates = this.listCoins().filter((coin) => coin.marketCapUsd > 12_000).slice(0, 12);
    for (const coin of candidates.slice(0, 4)) {
      const sim = this.coins.get(coin.address);
      if (!sim) continue;
      const amount = COIN_SUPPLY_HUMAN * between(rng, 0.0004, 0.004);
      sim.balances.set(address, (sim.balances.get(address) ?? 0) + amount);
      user.costBasisUsd.set(coin.address, amount * coin.priceUsd * between(rng, 0.35, 1.4));
      if (coin.terms.mode === "holders") user.holderRewards.set(coin.address, between(rng, 0.0004, 0.006) * (coin.quote.kind === "stable" ? 3000 : 1));
      this.refreshCoin(sim, Date.now());
    }
    if (rng() < 0.9) {
      const referred = candidates[4];
      if (referred) user.referralRewards.set(referred.address, between(rng, 0.0008, 0.004) * (referred.quote.kind === "stable" ? 3000 : 1));
    }
    if (asCreator) {
      // Hand three established coins to this wallet so the creator views have data.
      for (const coin of candidates.slice(5, 8)) {
        const sim = this.coins.get(coin.address);
        if (!sim) continue;
        const previous = sim.coin.creator;
        const devBalance = sim.balances.get(previous);
        if (devBalance !== undefined) {
          sim.balances.delete(previous);
          sim.balances.set(address, devBalance);
        }
        sim.trades = sim.trades.map((trade) => (trade.trader === previous ? { ...trade, trader: address } : trade));
        sim.coin = { ...sim.coin, creator: address };
        user.createdCoins.add(coin.address);
        this.refreshCoin(sim, Date.now());
      }
    }
  }

  /* ----------------------------------------------------------------- live */

  private tick(now: number) {
    this.tickCount += 1;
    const live = this.listCoins();
    if (live.length === 0) return;

    if (this.tickCount % LAUNCH_EVERY_TICKS === 5 && !this.settings.launchesPaused) this.liveLaunch(now);

    const weights = live.map((coin) => {
      const ageMin = (now - coin.createdAt) / 60_000;
      const fresh = ageMin < 15 ? 6 : ageMin < 120 ? 2 : 1;
      return Math.max(1, Math.sqrt(coin.momentum + 1)) * fresh;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const trades = Math.random() < 0.35 ? 2 : 1;
    for (let t = 0; t < trades; t += 1) {
      let roll = Math.random() * total;
      let chosen = live[0] as Coin;
      for (let i = 0; i < live.length; i += 1) {
        roll -= weights[i] as number;
        if (roll <= 0) {
          chosen = live[i] as Coin;
          break;
        }
      }
      const sim = this.coins.get(chosen.address);
      if (!sim) continue;
      const pool = [...sim.balances.keys()];
      const lifetime = Math.max(1, now - sim.coin.createdAt);
      // Live trades continue the archetype's trend past the history window.
      const fraction = clamp(lifetime / Math.max(lifetime, this.options.now - sim.coin.createdAt + 1), 0, 1);
      this.simulateTrade(sim, now, Math.random, pool, sim.archetype === "newborn" ? clamp(lifetime / 600_000, 0, 1) : fraction);
      this.refreshCoin(sim, now);
    }

    // Snipers hit coins that are inside launch protection.
    for (const coin of live) {
      const elapsed = (now - coin.createdAt) / 1000;
      if (elapsed > 0.5 && elapsed < coin.terms.snipeDurationSec && Math.random() < 0.25) {
        const sim = this.coins.get(coin.address);
        if (!sim) continue;
        this.applyTrade(sim, "buy", seededAddress(Math.random), between(Math.random, 20, 120) / coin.quote.usdPrice, now);
        this.refreshCoin(sim, now);
      }
    }

    // Holder epochs that ended while the page was open.
    for (const coin of live) {
      if (coin.terms.mode === "holders" && coin.stats.nextEpochAt <= now) {
        const sim = this.coins.get(coin.address);
        if (sim) this.refreshCoin(sim, now);
      }
    }
    this.emit();
  }

  private liveLaunch(now: number) {
    let entry = PREVIEW_COINS[this.liveNameIndex];
    if (entry && this.liveNameIndex < PREVIEW_COINS.length) {
      this.liveNameIndex += 1;
    } else {
      const n = this.tickCount;
      const adjective = LIVE_ADJECTIVES[n % LIVE_ADJECTIVES.length] as string;
      const animal = LIVE_ANIMALS[Math.floor(n / LIVE_ADJECTIVES.length) % LIVE_ANIMALS.length] as string;
      entry = { name: `${adjective} ${animal}`, symbol: (adjective.slice(0, 2) + animal.slice(0, 3)).toUpperCase(), description: `A fresh ${animal.toLowerCase()} on Base.` };
    }
    const seed = hashString(entry.name + now);
    const crng = createRng(seed);
    const creator = pick(crng, this.creators).address;
    const quote = crng() < 0.8 ? ETH : USDC;
    const mode: FeeMode = pick(crng, ["creator", "creator", "burn", "holders", "floor"]);
    const sim = this.createSim({
      address: seededAddress(crng, "b20"),
      name: entry.name,
      symbol: entry.symbol,
      description: entry.description,
      image: mascotDataUri(seed),
      links: {},
      creator,
      createdAt: now,
      quote,
      terms: {
        feeBps: pick(crng, [100, 100, 150, 200]),
        mode,
        creatorKeepBps: mode === "creator" ? 0 : 2500,
        platformShareBps: this.settings.platformShareBps,
        referralShareBps: this.settings.referralShareBps,
        snipeStartBps: this.settings.snipeStartBps,
        snipeDurationSec: this.settings.snipeDurationSec,
      },
      openingFdvUsd: this.settings.openingFdvUsd,
      archetype: "newborn",
      peak: between(crng, 1.5, 5),
      seed,
    });
    if (crng() < 0.75) this.applyTrade(sim, "buy", creator, between(crng, 20, 150) / quote.usdPrice, now, { firstBuy: true, rng: crng });
    this.refreshCoin(sim, now);
    this.pushActivity({ id: `launch-${sim.coin.address}`, kind: "launch", coin: sim.coin.address, ts: now });
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
