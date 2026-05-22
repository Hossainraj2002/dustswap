"use client";

import { formatUnits } from "viem";
import { TokenLogo } from "@/components/sweep/TokenLogo";
import {
  type DustSweepQuoteResponse,
  type SelectedToken,
  type Token,
} from "@/types/dustsweep";

function formatOutput(quote: DustSweepQuoteResponse, tokenOut: Token | null) {
  if (!tokenOut) return "0";
  try {
    const value = formatUnits(BigInt(quote.netEstimatedOut || quote.totalEstimatedOut), tokenOut.decimals);
    const num = Number(value);
    return Number.isFinite(num)
      ? num.toLocaleString(undefined, { maximumFractionDigits: 6 })
      : value;
  } catch {
    return "0";
  }
}

function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

const GENERIC_DEX_ICON = "/dex/generic.svg";

const DEX_ICONS: Record<string, string> = {
  UNISWAP_V3: "/dex/uniswap.svg",
  UNISWAP_V4: "/dex/uniswap.svg",
  AERODROME: "/dex/aerodrome.svg",
  PANCAKESWAP_V3: "/dex/pancake.svg",
  BASESWAP: "/dex/baseswap.svg",
  GENERIC: GENERIC_DEX_ICON,
};

function getDexIcon(dexName: string) {
  return DEX_ICONS[dexName] || GENERIC_DEX_ICON;
}

function formatDexName(dexName: string) {
  if (dexName.startsWith("UNISWAP")) return "Uniswap";
  if (dexName === "PANCAKESWAP_V3") return "PancakeSwap";
  if (dexName === "AERODROME") return "Aerodrome";
  if (dexName === "BASESWAP") return "BaseSwap";
  return dexName.replace(/_/g, " ");
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path fill="currentColor" d="M13.2 2 4.8 13.1h6.1L9.8 22l8.8-12h-6.3L13.2 2Z" />
    </svg>
  );
}

function GasIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        d="M3 20V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3.5l2 1V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm4-10h6M7 14h4"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 7v5l3 3" />
    </svg>
  );
}

export function RouteDisplay({
  quote,
  tokenOut,
  selectedTokens,
}: {
  quote: DustSweepQuoteResponse | null;
  tokenOut: Token | null;
  selectedTokens: SelectedToken[];
}) {
  if (!quote || !tokenOut) return null;

  const routeItems = quote.routes
    .slice(0, 6)
    .map((route) => ({
      route,
      token: selectedTokens.find((item) => item.address.toLowerCase() === route.tokenIn.toLowerCase()),
    }))
    .filter((item): item is { route: DustSweepQuoteResponse["routes"][number]; token: SelectedToken } =>
      Boolean(item.token),
    );
  const providerCount = new Set(quote.routes.map((route) => route.dexName)).size || 1;
  const remainder = quote.routes.length - routeItems.length;

  return (
    <div className="rounded-[8px] border border-blue-300 bg-blue-50 px-3 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white">
              <BoltIcon />
            </span>
            <span className="font-semibold text-slate-950">Smart Routing</span>
            <span className="text-xs text-slate-500">
              {quote.routes.length}/{selectedTokens.length} assets | {providerCount} provider{providerCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1">
              <GasIcon />
              ~{formatUsd(quote.gasEstimateUSD)}
            </span>
            <span className="inline-flex items-center gap-1">
              <ClockIcon />
              ~2s
            </span>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p className="font-mono text-base font-semibold text-slate-950">
            {formatOutput(quote, tokenOut)} {tokenOut.symbol}
          </p>
          <p className="text-xs text-slate-500">
            ~${(quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD).toFixed(2)}
          </p>
        </div>
      </div>

      <div className="my-2 h-px bg-blue-200" />

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
        {routeItems.map(({ token, route }) => {
          const dexLabel = formatDexName(route.dexName);

          return (
            <span key={token.address} className="inline-flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-full bg-white px-1.5 py-0.5 shadow-sm">
                <TokenLogo token={token} size="sm" />
                <span className="font-semibold">{token.symbol}</span>
                <img
                  src={getDexIcon(route.dexName)}
                  alt={dexLabel}
                  title={dexLabel}
                  className="h-5 w-5 rounded-full border border-blue-100 bg-white object-contain p-0.5"
                />
                <span className="max-w-[74px] truncate text-[11px] font-medium text-blue-700">
                  {dexLabel}
                </span>
              </span>
              <span className="text-slate-400">-&gt;</span>
            </span>
          );
        })}
        {remainder > 0 ? (
          <span className="rounded-full bg-white px-2 py-1 text-xs font-medium text-slate-500 shadow-sm">
            +{remainder} more
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-950 px-1.5 py-0.5 text-white shadow-sm">
          <TokenLogo token={tokenOut} size="sm" />
          <span className="font-semibold">{tokenOut.symbol}</span>
        </span>
      </div>
    </div>
  );
}
