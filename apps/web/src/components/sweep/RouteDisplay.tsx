"use client";

import { useState } from "react";
import { formatUnits } from "viem";
import {
  type DustSweepQuoteResponse,
  type DustSweepRoute,
  type SelectedToken,
  type Token,
} from "@/types/dustsweep";

const MAX_VISIBLE_ROUTES = 5;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

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

// Official brand logos for every DEX the sweep router can route through.
const DEX_ICONS: Record<string, string> = {
  UNISWAP_V3: "/dex/uniswap.png",
  UNISWAP_V4: "/dex/uniswap.png",
  AERODROME: "/dex/aerodrome.png",
  AERODROME_SLIPSTREAM: "/dex/aerodrome.png",
  PANCAKESWAP_V3: "/dex/pancakeswap.png",
  BASESWAP: "/dex/baseswap.png",
  ALIENBASE: "/dex/alienbase.png",
  ALIEN_BASE: "/dex/alienbase.png",
  DACKIESWAP: "/dex/dackieswap.png",
  GENERIC: GENERIC_DEX_ICON,
};

function getDexIcon(dexName: string) {
  return DEX_ICONS[dexName] || GENERIC_DEX_ICON;
}

function formatDexName(dexName: string) {
  if (dexName === "UNISWAP_V3") return "Uniswap V3";
  if (dexName === "UNISWAP_V4") return "Uniswap V4";
  if (dexName.startsWith("UNISWAP")) return "Uniswap";
  if (dexName === "PANCAKESWAP_V3") return "PancakeSwap";
  if (dexName === "AERODROME_SLIPSTREAM") return "Aerodrome CL";
  if (dexName === "AERODROME") return "Aerodrome";
  if (dexName === "BASESWAP") return "BaseSwap";
  if (dexName === "ALIENBASE" || dexName === "ALIEN_BASE") return "AlienBase";
  if (dexName === "DACKIESWAP") return "DackieSwap";
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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3 w-3">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M3 20V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3.5l2 1V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm4-10h6M7 14h4"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3 w-3">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 7v5l3 3" />
    </svg>
  );
}

function TinyArrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-300">
      <path d="M5 12h13m-5-6 6 6-6 6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
    </svg>
  );
}

// Tiny round token icon with a letter fallback — TokenLogo's smallest size is
// too bulky for the compact route pills.
function MiniTokenIcon({
  token,
  className = "h-5 w-5",
}: {
  token: Pick<Token, "symbol" | "logoURI">;
  className?: string;
}) {
  if (token.logoURI) {
    return (
      <img
        src={token.logoURI}
        alt={token.symbol}
        className={cx("shrink-0 rounded-full bg-white object-cover", className)}
      />
    );
  }
  return (
    <span
      className={cx(
        "flex shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-600",
        className,
      )}
    >
      {token.symbol?.slice(0, 1) || "?"}
    </span>
  );
}

function RoutePill({ token, route }: { token: SelectedToken; route: DustSweepRoute }) {
  const dexLabel = formatDexName(route.dexName);
  return (
    <div
      className="flex min-w-0 items-center gap-1 rounded-full border border-slate-100 bg-slate-50 py-1 pl-1 pr-1 sm:gap-1.5"
      title={`${token.symbol} via ${dexLabel}`}
    >
      <MiniTokenIcon token={token} />
      <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-800">
        {token.symbol}
      </span>
      {/* The connector arrow only fits once pills are wider than ~110px. */}
      <span className="hidden shrink-0 sm:block">
        <TinyArrow />
      </span>
      <img
        src={getDexIcon(route.dexName)}
        alt={dexLabel}
        className="h-5 w-5 shrink-0 rounded-full bg-white object-contain p-px shadow-sm ring-1 ring-slate-200"
      />
    </div>
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
  const [expanded, setExpanded] = useState(false);

  if (!quote || !tokenOut) return null;

  const routeItems = quote.routes
    .map((route) => ({
      route,
      token: selectedTokens.find((item) => item.address.toLowerCase() === route.tokenIn.toLowerCase()),
    }))
    .filter((item): item is { route: DustSweepRoute; token: SelectedToken } => Boolean(item.token));
  const visibleItems = expanded ? routeItems : routeItems.slice(0, MAX_VISIBLE_ROUTES);
  const remainder = routeItems.length - visibleItems.length;

  // Providers ranked by how many tokens they route, for the footer summary.
  const dexCounts = new Map<string, number>();
  for (const route of quote.routes) {
    dexCounts.set(route.dexName, (dexCounts.get(route.dexName) || 0) + 1);
  }
  const rankedDexes = [...dexCounts.entries()].sort((a, b) => b[1] - a[1]);
  const providerCount = rankedDexes.length || 1;
  const namedDexes = rankedDexes.slice(0, 2);
  const extraDexCount = rankedDexes.length - namedDexes.length;
  const dexSummary =
    namedDexes.map(([dexName, count]) => `${formatDexName(dexName)}${count > 1 ? ` ×${count}` : ""}`).join(" · ") +
    (extraDexCount > 0 ? ` +${extraDexCount}` : "");

  return (
    <div className="overflow-hidden rounded-[8px] border border-blue-200 bg-white shadow-sm">
      {/* ── Header: title + meta on the left, estimated output on the right ── */}
      <div className="flex items-start justify-between gap-3 px-3.5 pt-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-blue-600 text-white shadow-[0_6px_14px_rgba(37,99,235,0.3)]">
            <BoltIcon />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-950">Smart Routing</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] font-medium text-slate-500">
              <span>
                {quote.routes.length}/{selectedTokens.length} tokens
              </span>
              <span className="text-slate-300">|</span>
              <span>
                {providerCount} provider{providerCount === 1 ? "" : "s"}
              </span>
              <span className="text-slate-300">|</span>
              <span className="inline-flex items-center gap-1">
                <GasIcon />~{formatUsd(quote.gasEstimateUSD)}
              </span>
              <span className="text-slate-300">|</span>
              <span className="inline-flex items-center gap-1">
                <ClockIcon />
                ~2s
              </span>
            </div>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p className="font-mono text-base font-bold leading-tight text-slate-950">
            {formatOutput(quote, tokenOut)} {tokenOut.symbol}
          </p>
          <p className="text-[11px] font-medium text-slate-500">
            ~${(quote.netEstimatedOutUSD ?? quote.totalEstimatedOutUSD).toFixed(2)}
          </p>
        </div>
      </div>

      {/* ── Compact route grid: token → official DEX logo, 3 per row ── */}
      <div className="grid grid-cols-3 gap-1.5 px-3.5 py-3">
        {visibleItems.map(({ token, route }) => (
          <RoutePill key={token.address} token={token} route={route} />
        ))}
        {remainder > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex items-center justify-center rounded-full border border-dashed border-blue-200 bg-blue-50/50 px-2 py-1 text-[11px] font-bold text-blue-600 transition hover:border-blue-300 hover:bg-blue-50"
          >
            +{remainder} more
          </button>
        ) : null}
        {expanded && routeItems.length > MAX_VISIBLE_ROUTES ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex items-center justify-center rounded-full border border-dashed border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-400 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-600"
          >
            Show less
          </button>
        ) : null}
      </div>

      {/* ── Footer: providers used → output token ── */}
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/80 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 -space-x-1.5">
            {/* Dedupe by icon: Aerodrome classic + Slipstream share one brand logo. */}
            {[...new Set(rankedDexes.map(([dexName]) => getDexIcon(dexName)))]
              .slice(0, 4)
              .map((icon) => (
                <img
                  key={icon}
                  src={icon}
                  alt=""
                  className="h-5 w-5 rounded-full border-2 border-white bg-white object-contain shadow-sm"
                />
              ))}
          </div>
          <span className="truncate text-[11px] font-medium text-slate-500">via {dexSummary}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <TinyArrow />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-950 py-1 pl-1 pr-2.5 text-white shadow-sm">
            <MiniTokenIcon token={tokenOut} />
            <span className="text-xs font-bold">{tokenOut.symbol}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
