/** UI choices stay separate from the concrete limit frozen into a transaction. */
export type SlippageSetting =
  | { mode: "auto" }
  | { mode: "preset"; bps: number }
  | { mode: "custom"; text: string };

export const SLIPPAGE_PRESETS_BPS = [100, 300, 500, 1000] as const;
export const MAX_SLIPPAGE_BPS = 5000;
export const AUTO_MAX_SLIPPAGE_BPS = 500;
export const CUSTOM_SLIPPAGE_ERROR = "Enter 0.01% to 50%, with up to two decimal places.";

/** Parse decimal percentages exactly. An incomplete/invalid edit never retains an old limit. */
export function parseSlippagePercent(text: string): number | null {
  const value = text.trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) return null;
  const [whole = "", fraction = ""] = value.split(".");
  const bps = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(bps) && bps > 0 && bps <= MAX_SLIPPAGE_BPS ? bps : null;
}

export function resolveSlippageBps(setting: SlippageSetting, autoBps: number): number | null {
  if (setting.mode === "custom") return parseSlippagePercent(setting.text);
  const bps = setting.mode === "auto" ? autoBps : setting.bps;
  const max = setting.mode === "auto" ? AUTO_MAX_SLIPPAGE_BPS : MAX_SLIPPAGE_BPS;
  return Number.isInteger(bps) && bps > 0 && bps <= max ? bps : null;
}

interface AutoSlippageInput {
  createdAt: number;
  liquidityUsd: number;
  now: number;
  trades: ReadonlyArray<{ ts: number; priceUsd: number }>;
}

/**
 * A bounded local estimate, not an execution oracle. Young/thin pools or missing
 * fresh history use 5%. Mature pools start at 1% ($250k+) or 3% ($50k+).
 * Twice the largest observed price move in the last minute plus 0.5% raises the
 * floor, rounded up to 0.25%, and capped at 5%. Quote price impact already affects
 * expected output, so it must not be added a second time as slippage.
 */
export function autoSlippageBps({ createdAt, liquidityUsd, now, trades }: AutoSlippageInput): number {
  if (!Number.isFinite(now) || !Number.isFinite(createdAt) || now < createdAt + 600_000
    || !Number.isFinite(liquidityUsd) || liquidityUsd < 50_000) return AUTO_MAX_SLIPPAGE_BPS;
  const recent = trades.filter(trade => Number.isFinite(trade.ts) && trade.ts > now - 60_000 && trade.ts <= now
    && Number.isFinite(trade.priceUsd) && trade.priceUsd > 0).sort((a, b) => a.ts - b.ts);
  // Sparse/stale data cannot establish a calm market.
  if (recent.length < 3 || recent[recent.length - 1]!.ts < now - 15_000) return AUTO_MAX_SLIPPAGE_BPS;
  let moveBps = 0;
  for (let i = 1; i < recent.length; i++) {
    moveBps = Math.max(moveBps, Math.abs(recent[i]!.priceUsd / recent[i - 1]!.priceUsd - 1) * 10_000);
  }
  const floor = liquidityUsd >= 250_000 ? 100 : 300;
  return Math.min(AUTO_MAX_SLIPPAGE_BPS, Math.max(floor, Math.ceil((moveBps * 2 + 50) / 25) * 25));
}
