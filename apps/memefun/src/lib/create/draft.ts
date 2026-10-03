import { COIN_SUPPLY, FIRST_BUY_WARN_SUPPLY_FRACTION } from "@/core/constants";
import { toUnits } from "@/core/format";
import { createLaunchPool, quoteBuy } from "@/core/pool";
import type { LaunchSettings } from "@/core/settings";
import type { FeeMode, QuoteAsset } from "@/core/types";
import { validateDescription, validateName, validateTelegram, validateTicker, validateWebsite, validateXHandle } from "@/core/validation";

export interface CreateDraft {
  image: string | null;
  name: string;
  ticker: string;
  description: string;
  x: string;
  telegram: string;
  website: string;
  quoteSymbol: string;
  feeBps: number;
  mode: FeeMode;
  creatorKeepBps: number;
  firstBuy: string;
}

export const EMPTY_DRAFT: CreateDraft = {
  image: null,
  name: "",
  ticker: "",
  description: "",
  x: "",
  telegram: "",
  website: "",
  quoteSymbol: "ETH",
  feeBps: 100,
  mode: "creator",
  creatorKeepBps: 2500,
  firstBuy: "",
};

export const STEPS = [
  { id: "coin", label: "Coin" },
  { id: "pair", label: "Pair" },
  { id: "fees", label: "Fees" },
  { id: "buy", label: "First buy" },
  { id: "review", label: "Review" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export type DraftErrors = Partial<Record<keyof CreateDraft, string>>;

export function validateCoinStep(draft: CreateDraft): DraftErrors {
  const errors: DraftErrors = {};
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
  if (draft.feeBps < settings.feeMinBps || draft.feeBps > settings.feeMaxBps) {
    errors.feeBps = `Pick a fee between ${settings.feeMinBps / 100}% and ${settings.feeMaxBps / 100}%.`;
  }
  if (!settings.enabledModes.includes(draft.mode)) errors.mode = "This fee destination is not available right now.";
  if (draft.mode !== "creator" && (draft.creatorKeepBps < 0 || draft.creatorKeepBps > settings.creatorKeepMaxBps)) {
    errors.creatorKeepBps = `Keep at most ${settings.creatorKeepMaxBps / 100}%.`;
  }
  return errors;
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
export function previewFirstBuy(amount: string, quote: QuoteAsset, feeBps: number, openingFdvUsd: number): FirstBuyPreview | null {
  const raw = toUnits(amount, quote.decimals);
  if (raw <= 0n) return null;
  // ETH and USDC sort below every B20 address, so the coin is currency1. A
  // stock is B20 too and may sort either way; both orderings price within one
  // tick spacing of each other (see pool.test.ts), which is fine for a preview.
  const pool = createLaunchPool({ coinIsCurrency0: false, quoteDecimals: quote.decimals, quoteUsd: quote.usdPrice, openingFdvUsd });
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

export function loadDraft(): CreateDraft | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<CreateDraft>) };
  } catch {
    return null;
  }
}

export function saveDraft(draft: CreateDraft) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Quota exceeded (large image) or storage blocked: keep the rest without the image.
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...draft, image: null }));
    } catch {
      // Ignore.
    }
  }
}

export function clearDraft() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
