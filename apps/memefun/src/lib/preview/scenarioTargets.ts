import type { Coin } from "@/lib/market/types";
import type { ScenarioId } from "./scenario";

/** Scenarios that are about one kind of coin open a coin of that kind. */
export const COIN_FOR_SCENARIO: Partial<Record<ScenarioId, (coin: Coin, now: number) => boolean>> = {
  "burn-mode": (coin) => coin.terms.mode === "burn" && coin.stats.burnedCoins > 0,
  "holder-mode": (coin) => coin.terms.mode === "holders" && coin.stats.holdersPaidQuote > 0,
  "floor-mode": (coin) => coin.terms.mode === "floor" && coin.stats.floorQuote > 0,
  "usdc-pair": (coin) => coin.quote.symbol === "USDC",
  "stock-pair": (coin) => coin.quote.kind === "stock",
  "launch-protection": (coin, now) => now - coin.createdAt < coin.terms.snipeDurationSec * 1000,
};
