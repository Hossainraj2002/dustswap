import { COIN_SUPPLY, FIRST_BUY_WARN_SUPPLY_FRACTION } from "@/core/constants";
import { toUnits } from "@/core/format";
import { createLaunchPool, quoteBuy } from "@/core/pool";
import type { LaunchSettings } from "@/core/settings";
import type { FeeMode, QuoteAsset } from "@/core/types";
import { validateDescription, validateName, validateTelegram, validateTicker, validateWebsite, validateXHandle } from "@/core/validation";
import { AUTHOR_SHARE_DEFAULT_BPS, validAuthorShare, type TweetDraft } from "./tweet";
import { parseTweetUrl, validXId } from "@/core/tweet";
import { findPair, pairId, pairUnavailableReason } from "@/lib/market/pairs";

export interface CreateDraft {
  entry: "manual" | "tweet";
  tweet?: TweetDraft;
  image: string | null;
  name: string;
  ticker: string;
  description: string;
  x: string;
  telegram: string;
  website: string;
  quoteId: string;
  launchMode: "single" | "multi";
  quoteIds: string[];
  firstBuyQuoteId: string;
  feeBps: number;
  mode: FeeMode;
  creatorKeepBps: number;
  firstBuy: string;
}

export const EMPTY_DRAFT: CreateDraft = {
  entry: "manual",
  image: null,
  name: "",
  ticker: "",
  description: "",
  x: "",
  telegram: "",
  website: "",
  quoteId: "0x0000000000000000000000000000000000000000",
  launchMode: "single",
  quoteIds: ["0x0000000000000000000000000000000000000000"],
  firstBuyQuoteId: "0x0000000000000000000000000000000000000000",
  feeBps: 100,
  mode: "creator",
  creatorKeepBps: 2500,
  firstBuy: "",
};

export const STEPS = [
  { id: "coin", label: "Coin" },
  { id: "pair", label: "Pairs" },
  { id: "fees", label: "Fees" },
  { id: "buy", label: "First buy" },
  { id: "review", label: "Review" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export type DraftErrors = Partial<Record<keyof CreateDraft, string>>;

export function validateCoinStep(draft: CreateDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.entry === "tweet" && !draft.tweet?.source.postId) errors.tweet = "Import a public X post first.";
  if (!draft.image) errors.image = "Add an image. Coins without one are hard to spot in the feed.";
  const name = validateName(draft.name);
  if (!name.ok) errors.name = name.error;
  const ticker = validateTicker(draft.ticker);
  if (!ticker.ok) errors.ticker = ticker.error;
  const description = validateDescription(draft.description);
  if (!description.ok) errors.description = description.error;
  const x = validateXHandle(draft.x);
  if (!x.ok) errors.x = x.error;
  const telegram = validateTelegram(draft.telegram);
  if (!telegram.ok) errors.telegram = telegram.error;
  const website = validateWebsite(draft.website);
  if (!website.ok) errors.website = website.error;
  return errors;
}

export function validateFeesStep(draft: CreateDraft, settings: LaunchSettings): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.entry === "tweet" && (draft.mode !== "creator" || !draft.tweet || !validAuthorShare(draft.tweet.authorShareBps))) errors.tweet = "Tweet launches need creator mode and an author share between 20% and 100%.";
  if (draft.feeBps < settings.feeMinBps || draft.feeBps > settings.feeMaxBps) {
    errors.feeBps = `Pick a fee between ${settings.feeMinBps / 100}% and ${settings.feeMaxBps / 100}%.`;
  }
  if (!settings.enabledModes.includes(draft.mode)) errors.mode = "This fee destination is not available right now.";
  if (draft.mode !== "creator" && (draft.creatorKeepBps < 0 || draft.creatorKeepBps > settings.creatorKeepMaxBps)) {
    errors.creatorKeepBps = `Keep at most ${settings.creatorKeepMaxBps / 100}%.`;
  }
  return errors;
}

/** The optional buy must be representable in the selected pool's quote asset. */
export function validateFirstBuyStep(draft: CreateDraft, quote: QuoteAsset, balance?: number): DraftErrors {
  const text = draft.firstBuy.trim();
  if (!text) return {};
  const amount = Number(text);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(amount) || amount < 0) {
    return { firstBuy: "Enter a valid amount." };
  }
  const fraction = text.split(".")[1] ?? "";
  if (fraction.slice(quote.decimals).replace(/0/g, "")) {
    return { firstBuy: `${quote.symbol} supports up to ${quote.decimals} decimal places.` };
  }
  if (balance !== undefined && amount > balance) return { firstBuy: `Not enough ${quote.symbol}.` };
  return {};
}

export interface FirstBuyPreview {
  coins: number;
  supplyFraction: number;
  marketCapUsd: number;
  feeQuote: number;
  warn: boolean;
}

/**
 * Exact preview of the creator's first buy using the same pool math as the
 * contracts: the fresh single-sided position, the normal fee (first buys are
 * exempt from launch protection), and the tick-snapped opening price.
 */
export function previewFirstBuy(amount: string, quote: QuoteAsset, feeBps: number, openingFdvUsd: number, allocationSupply = COIN_SUPPLY): FirstBuyPreview | null {
  if (!Number.isFinite(quote.usdPrice) || quote.usdPrice <= 0 || !Number.isFinite(openingFdvUsd) || openingFdvUsd <= 0 || allocationSupply <= 0n) return null;
  const raw = toUnits(amount, quote.decimals);
  if (raw <= 0n) return null;
  // ETH and USDC sort below every B20 address, so the coin is currency1. A
  // stock is B20 too and may sort either way; both orderings price within one
  // tick spacing of each other (see pool.test.ts), which is fine for a preview.
  const pool = createLaunchPool({ coinIsCurrency0: false, quoteDecimals: quote.decimals, quoteUsd: quote.usdPrice, openingFdvUsd, allocationSupply });
  const result = quoteBuy(pool, raw, feeBps);
  const coins = Number(result.amountOut) / 1e18;
  const supplyFraction = Number((result.amountOut * 1_000_000n) / COIN_SUPPLY) / 1_000_000;
  return {
    coins,
    supplyFraction,
    marketCapUsd: result.priceAfter * 1_000_000_000 * quote.usdPrice,
    feeQuote: Number(result.fee) / 10 ** quote.decimals,
    warn: supplyFraction > FIRST_BUY_WARN_SUPPLY_FRACTION,
  };
}

const STORAGE_KEY = "memefun:create-draft";

export function loadDraft(entry: CreateDraft["entry"] = "manual"): CreateDraft | null {
  try {
    const raw = window.sessionStorage.getItem(entry === "tweet" ? `${STORAGE_KEY}:tweet` : STORAGE_KEY);
    if (!raw) return null;
    return migrateDraft(JSON.parse(raw) as SavedDraft);
  } catch {
    return null;
  }
}

type SavedDraft = Partial<CreateDraft> & { quoteSymbol?: string; quoteSymbols?: string[]; firstBuyQuoteSymbol?: string };

export function migrateDraft(saved: SavedDraft): CreateDraft {
  const quoteId = saved.quoteId || saved.quoteSymbol || EMPTY_DRAFT.quoteId;
  const entries = saved.quoteIds ?? saved.quoteSymbols;
  const provided = Array.isArray(entries) ? entries.filter((id) => typeof id === "string" && id.length > 0) : [];
  const normalize = (id: string) => /^0x[0-9a-f]{40}$/i.test(id) ? id.toLowerCase() : id;
  const quoteIds = [...new Set((provided.length ? provided : [quoteId]).map(normalize))].slice(0, 5);
  const savedBuyQuote = normalize(saved.firstBuyQuoteId ?? saved.firstBuyQuoteSymbol ?? quoteId);
  let tweet = saved.tweet;
  try {
    if (!tweet?.source || !validXId(tweet.source.postId) || !validXId(tweet.source.author?.id) || parseTweetUrl(tweet.source.url).postId !== tweet.source.postId) tweet = undefined;
    else tweet = { ...tweet, authorShareBps: validAuthorShare(tweet.authorShareBps) ? tweet.authorShareBps : AUTHOR_SHARE_DEFAULT_BPS };
  } catch { tweet = undefined; }
  const { quoteSymbol: _oldPrimary, quoteSymbols: _oldPairs, firstBuyQuoteSymbol: _oldBuy, ...current } = saved;
  void _oldPrimary; void _oldPairs; void _oldBuy;
  return { ...EMPTY_DRAFT, ...current, entry: saved.entry === "tweet" ? "tweet" : "manual", launchMode: saved.launchMode === "multi" ? "multi" : "single", quoteId: quoteIds[0] ?? quoteId,
    tweet, mode: saved.entry === "tweet" ? "creator" : (saved.mode ?? EMPTY_DRAFT.mode), quoteIds, firstBuyQuoteId: quoteIds.includes(savedBuyQuote) ? savedBuyQuote : quoteIds[0]!,
    firstBuy: quoteIds.includes(savedBuyQuote) ? (saved.firstBuy ?? "") : "" };
}

export function selectedQuoteIds(draft: CreateDraft): string[] {
  return draft.launchMode === "multi" ? draft.quoteIds : [draft.quoteId];
}

/** Resolve legacy symbols once the current chain's registry is loaded. Never guess a duplicate ticker. */
export function reconcileDraftQuotes(draft: CreateDraft, quotes: QuoteAsset[]): CreateDraft {
  if (!quotes.length) return draft;
  const ids = [...new Set(selectedQuoteIds(draft).map(id => findPair(quotes, id)).filter((quote): quote is QuoteAsset => Boolean(quote)).map(pairId))];
  if (!ids.length) ids.push(pairId(quotes.find(quote => !pairUnavailableReason(quote)) ?? quotes[0]!));
  const savedBuy = findPair(quotes, draft.firstBuyQuoteId);
  const firstBuyQuoteId = savedBuy && ids.includes(pairId(savedBuy)) ? pairId(savedBuy) : ids[0]!;
  const firstBuy = savedBuy && ids.includes(pairId(savedBuy)) ? draft.firstBuy : "";
  if (ids.join() === selectedQuoteIds(draft).join() && draft.quoteId === ids[0] && draft.firstBuyQuoteId === firstBuyQuoteId && firstBuy === draft.firstBuy) return draft;
  return { ...draft, quoteId: ids[0]!, quoteIds: ids, firstBuyQuoteId, firstBuy };
}

export function reconcileDraftSettings(draft: CreateDraft, settings: LaunchSettings): CreateDraft {
  return { ...draft, feeBps: Math.max(settings.feeMinBps, Math.min(settings.feeMaxBps, draft.feeBps)),
    creatorKeepBps: Math.max(0, Math.min(settings.creatorKeepMaxBps, draft.creatorKeepBps)),
    mode: draft.entry === "tweet" ? "creator" : settings.enabledModes.includes(draft.mode) ? draft.mode : (settings.enabledModes[0] ?? draft.mode) };
}

export function validatePairs(draft: CreateDraft, quotes: QuoteAsset[], settings: LaunchSettings, stocksRestricted: boolean): DraftErrors {
  const ids = selectedQuoteIds(draft);
  if (!ids.length || ids.length > 5) return { quoteId: "Choose between one and five pools." };
  const selected = ids.map((id) => findPair(quotes, id));
  if (selected.some((quote) => !quote)) return { quoteId: "Choose listed pair assets." };
  if (new Set(selected.map((quote) => pairId(quote!))).size !== selected.length) return { quoteId: "Each pool needs a different pair asset." };
  if (selected.some((quote) => stocksRestricted && quote!.kind === "stock")) return { quoteId: "Stock pairs are not available in your region." };
  const unavailable = selected.map(quote => pairUnavailableReason(quote!, settings.enabledQuoteKinds)).find(Boolean);
  if (unavailable) return { quoteId: unavailable };
  return {};
}

export function saveDraft(draft: CreateDraft) {
  try {
    window.sessionStorage.setItem(draft.entry === "tweet" ? `${STORAGE_KEY}:tweet` : STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Quota exceeded (large image) or storage blocked: keep the rest without the image.
    try {
      window.sessionStorage.setItem(draft.entry === "tweet" ? `${STORAGE_KEY}:tweet` : STORAGE_KEY, JSON.stringify({ ...draft, image: null }));
    } catch {
      // Ignore.
    }
  }
}

export function clearDraft(entry: CreateDraft["entry"] = "manual") {
  try {
    window.sessionStorage.removeItem(entry === "tweet" ? `${STORAGE_KEY}:tweet` : STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
