/**
 * The trade panel's primary button. One pure function decides what it says
 * and whether it is enabled, so every state is reviewable and tested.
 */
export type TradeCta =
  | { kind: "connect"; label: string; enabled: true }
  | { kind: "switch"; label: string; enabled: true }
  | { kind: "restricted"; label: string; enabled: false }
  | { kind: "enter-amount"; label: string; enabled: false }
  | { kind: "insufficient"; label: string; enabled: false }
  | { kind: "no-liquidity"; label: string; enabled: false }
  | { kind: "pending"; label: string; enabled: false }
  | { kind: "ready"; label: string; enabled: true };

export interface TradeCtaInput {
  connected: boolean;
  onBase: boolean;
  side: "buy" | "sell";
  amount: number;
  balance: number;
  payingSymbol: string;
  coinSymbol: string;
  restricted: boolean;
  pending: boolean;
  quoteOk: boolean;
}

export function tradeCta(input: TradeCtaInput): TradeCta {
  if (!input.connected) return { kind: "connect", label: "Connect wallet", enabled: true };
  if (input.restricted) return { kind: "restricted", label: "Not available in your region", enabled: false };
  if (!input.onBase) return { kind: "switch", label: "Switch to Base", enabled: true };
  if (input.pending) return { kind: "pending", label: "Confirm in your wallet", enabled: false };
  if (!(input.amount > 0)) return { kind: "enter-amount", label: "Enter an amount", enabled: false };
  if (input.amount > input.balance + 1e-12) {
    return { kind: "insufficient", label: `Not enough ${input.payingSymbol}`, enabled: false };
  }
  if (!input.quoteOk) return { kind: "no-liquidity", label: "Amount too large for the pool", enabled: false };
  return { kind: "ready", label: `${input.side === "buy" ? "Buy" : "Sell"} ${input.coinSymbol}`, enabled: true };
}

/** Price-impact severity for the warning under the quote. */
export function impactLevel(priceImpact: number): "none" | "notice" | "high" {
  if (priceImpact >= 0.15) return "high";
  if (priceImpact >= 0.05) return "notice";
  return "none";
}

export const SLIPPAGE_PRESETS_BPS = [50, 100, 200, 500] as const;
export const DEFAULT_SLIPPAGE_BPS = 200;
export const MAX_SLIPPAGE_BPS = 5000;

export function buyPresets(symbol: string, kind: "native" | "stable" | "stock"): number[] {
  if (kind === "native") return [0.01, 0.05, 0.1, 0.25];
  if (kind === "stable") return [10, 25, 50, 100];
  void symbol;
  return [0.1, 0.25, 0.5, 1];
}
