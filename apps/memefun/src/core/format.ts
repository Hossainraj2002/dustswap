/**
 * Number and text formatting. User-visible output never contains the unicode
 * ellipsis, em-dash or arrow characters (house copy rule).
 */

const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

function toSubscript(value: number): string {
  return String(value)
    .split("")
    .map((digit) => SUBSCRIPT_DIGITS[Number(digit)] ?? digit)
    .join("");
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

const compactSuffixes: Array<[number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** 1234 -> "1.23K", 5_600_000 -> "5.6M". Values under 1,000 keep up to 2 decimals. */
export function formatCompact(value: number, maxFractionDigits = 2): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  for (const [threshold, suffix] of compactSuffixes) {
    if (abs >= threshold) {
      const scaled = abs / threshold;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : maxFractionDigits;
      return `${sign}${trimZeros(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return `${sign}${trimZeros(abs.toFixed(abs >= 100 ? 0 : maxFractionDigits))}`;
}

/**
 * Prices with many leading zeros use subscript notation, the convention on
 * DexScreener and GMGN: 0.0000041234 -> "0.0₅4123".
 */
export function formatSmallNumber(value: number, significant = 4): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1) {
    return sign + abs.toLocaleString("en-US", { maximumFractionDigits: abs >= 1000 ? 0 : 4 });
  }
  if (abs >= 0.001) {
    return sign + trimZeros(abs.toPrecision(significant));
  }
  const exponent = Math.floor(Math.log10(abs));
  const zeros = -exponent - 1;
  const digits = Math.round(abs * 10 ** (zeros + significant))
    .toString()
    .slice(0, significant)
    .replace(/0+$/, "");
  return `${sign}0.0${toSubscript(zeros)}${digits || "0"}`;
}

/** Plain-text reading of a small number for screen readers. */
export function spokenSmallNumber(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  if (Math.abs(value) >= 0.001) return String(Number(value.toPrecision(6)));
  return value.toExponential(3).replace("e-", " times ten to the minus ");
}

export function formatUsd(value: number, options: { compact?: boolean } = {}): string {
  if (!Number.isFinite(value)) return "$0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (options.compact && abs >= 1000) return `${sign}$${formatCompact(abs)}`;
  if (abs === 0) return "$0";
  if (abs < 0.01) return `${sign}$${formatSmallNumber(abs)}`;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: abs >= 1000 ? 0 : 2,
    maximumFractionDigits: abs >= 1000 ? 0 : 2,
  })}`;
}

/** Signed percent from a fraction: 0.1234 -> "+12.34%". */
export function formatPercent(fraction: number, options: { signed?: boolean; digits?: number } = {}): string {
  if (!Number.isFinite(fraction)) return "0%";
  const percent = fraction * 100;
  const abs = Math.abs(percent);
  const digits = options.digits ?? (abs >= 1000 ? 0 : abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  const body = abs >= 10_000 ? formatCompact(abs, 1) : trimZeros(abs.toFixed(digits));
  const sign = percent < 0 && body !== "0" ? "-" : options.signed && percent > 0 && body !== "0" ? "+" : "";
  return `${sign}${body}%`;
}

/** Basis points as a percent string: 125 -> "1.25%". */
export function formatBps(bps: number): string {
  return `${trimZeros((bps / 100).toFixed(2))}%`;
}

/** Quote amounts: "0.042 ETH", "12.5 USDC", "0.0₄12 ETH". */
export function formatQuoteAmount(value: number, symbol: string): string {
  if (!Number.isFinite(value) || value === 0) return `0 ${symbol}`;
  const abs = Math.abs(value);
  const body =
    abs >= 1000
      ? formatCompact(value)
      : abs >= 1
        ? trimZeros(value.toFixed(abs >= 100 ? 2 : 3))
        : formatSmallNumber(value, 3);
  return `${body} ${symbol}`;
}

/** Coin amounts are always compact: "12.4M", "843K". */
export function formatCoinAmount(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  return Math.abs(value) < 1 ? formatSmallNumber(value, 3) : formatCompact(value);
}

/** Short age: "12s", "4m", "2h", "3d", "5w", "8mo", "2y". */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Countdown "0:42" or "1:05:09". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** 0x12ab...cd34 (three ASCII dots, never the unicode ellipsis). */
export function shortAddress(address: string, lead = 4, tail = 4): string {
  if (!address) return "";
  if (address.length <= 2 + lead + tail + 3) return address;
  return `${address.slice(0, 2 + lead)}...${address.slice(-tail)}`;
}

/** Raw integer units to a float for display. */
export function fromUnits(raw: bigint, decimals: number): number {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  const value = Number(whole) + Number(fraction) / Number(base);
  return negative ? -value : value;
}

/** Decimal string to raw integer units, truncating extra precision. */
export function toUnits(value: string, decimals: number): bigint {
  const cleaned = value.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === "" || cleaned === ".") return 0n;
  const [whole = "0", fraction = ""] = cleaned.split(".");
  const paddedFraction = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(paddedFraction || "0");
}
