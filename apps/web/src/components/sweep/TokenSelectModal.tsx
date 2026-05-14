"use client";

import { useMemo, useState } from "react";
import { TokenLogo } from "@/components/sweep/TokenLogo";
import {
  type SelectedToken,
  type SwappableToken,
  type Token,
  type UnavailableToken,
} from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

const CHAIN_FILTERS = [
  { key: "base", label: "Base", icon: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png" },
] as const;

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        d="m21 21-4.35-4.35M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z"
      />
    </svg>
  );
}

function tokenMatchesSearch(token: Token, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  return (
    token.symbol.toLowerCase().includes(normalized) ||
    token.name.toLowerCase().includes(normalized) ||
    token.address.toLowerCase().includes(normalized)
  );
}

function reasonText(reason: UnavailableToken["reason"]) {
  if (reason === "NO_LIQUIDITY") return "No liquidity";
  if (reason === "NOT_WHITELISTED") return "Not whitelisted";
  if (reason === "BALANCE_CHANGED") return "Balance changed";
  if (reason === "QUOTE_FAILED") return "Quote failed";
  if (reason === "NATIVE_WRAP_REQUIRED") return "Wrap to WETH required";
  return "Below threshold";
}

export function TokenSelectModal({
  isOpen,
  mode,
  title,
  swappableTokens,
  unavailableTokens,
  selectedTokens,
  outputTokens,
  selectedOutputToken,
  onSelectToken,
  onSelectOutputToken,
  onClose,
}: {
  isOpen: boolean;
  mode: "multi" | "single";
  title: string;
  swappableTokens: SwappableToken[];
  unavailableTokens: UnavailableToken[];
  selectedTokens: SelectedToken[];
  outputTokens: Token[];
  selectedOutputToken: Token | null;
  onSelectToken: (token: SwappableToken) => void;
  onSelectOutputToken: (token: Token) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(
    () => new Set(selectedTokens.map((token) => token.address.toLowerCase())),
    [selectedTokens],
  );

  // Sort swappable by valueUSD descending — highest value first
  const visibleSwappable = useMemo(
    () =>
      swappableTokens
        .filter((token) => tokenMatchesSearch(token, query))
        .sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0)),
    [query, swappableTokens],
  );
  const visibleUnavailable = useMemo(
    () => unavailableTokens.filter((token) => tokenMatchesSearch(token, query)),
    [query, unavailableTokens],
  );
  const visibleOutputTokens = useMemo(
    () => outputTokens.filter((token) => tokenMatchesSearch(token, query)),
    [outputTokens, query],
  );

  function fmtBalance(value: string | undefined) {
    const num = Number(value || "0");
    if (!Number.isFinite(num) || num === 0) return "0";
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
    if (num >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 3 });
    if (num >= 0.001) return num.toPrecision(3);
    return num.toExponential(2);
  }

  function fmtUSD(value: number | undefined) {
    const v = value ?? 0;
    if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
    if (v >= 1) return `$${v.toFixed(2)}`;
    if (v >= 0.01) return `$${v.toFixed(3)}`;
    if (v > 0) return "<$0.01";
    return "$0.00";
  }

  if (!isOpen) return null;

  const list = mode === "single" ? visibleOutputTokens : visibleSwappable;

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/45 px-0 backdrop-blur-sm sm:items-center sm:px-4">
      <div className="flex max-h-[86dvh] w-full max-w-[520px] flex-col rounded-t-[8px] bg-white shadow-[0_30px_80px_rgba(15,23,42,0.22)] sm:rounded-[8px]">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full text-2xl font-light text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close token selector"
          >
            &times;
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-4 py-3 sm:px-5">
          <div className="relative">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search for a token or paste address"
              className="h-12 w-full rounded-[8px] border border-slate-200 bg-slate-50 px-4 pr-12 text-base text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-300 focus:bg-white"
            />
            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400">
              <SearchIcon />
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {CHAIN_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className={cx(
                  "flex h-[32px] items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition-colors",
                  filter.key === "base"
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-200 hover:bg-blue-50",
                )}
                title={filter.label}
              >
                {filter.icon && (
                  <img src={filter.icon} alt={filter.label} className="h-4 w-4 rounded-full" />
                )}
                {filter.label}
              </button>
            ))}
          </div>

          {mode === "single" ? (
            <div>
              <p className="mb-2 text-sm font-medium text-slate-500">Popular tokens</p>
              <div className="flex flex-wrap gap-2">
                {visibleOutputTokens.slice(0, 5).map((token) => (
                  <button
                    key={token.address}
                    type="button"
                    onClick={() => {
                      onSelectOutputToken(token);
                      onClose();
                    }}
                    className={cx(
                      "inline-flex min-h-[40px] items-center gap-2 rounded-[8px] border px-3 text-sm font-semibold",
                      selectedOutputToken?.address.toLowerCase() === token.address.toLowerCase()
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : "border-slate-200 bg-white text-slate-700",
                    )}
                  >
                    <TokenLogo token={token} size="sm" />
                    {token.symbol}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-sm font-medium text-slate-500">
              {mode === "single" ? "Your tokens" : "Your tokens"}
            </p>
            <div className="space-y-2">
              {list.map((token) => {
                const selected =
                  mode === "single"
                    ? selectedOutputToken?.address.toLowerCase() === token.address.toLowerCase()
                    : selectedSet.has(token.address.toLowerCase());

                return (
                  <button
                    key={token.address}
                    type="button"
                    onClick={() => {
                      if (mode === "single") {
                        onSelectOutputToken(token);
                        onClose();
                      } else {
                        onSelectToken(token as SwappableToken);
                      }
                    }}
                    className={cx(
                      "flex w-full items-center justify-between gap-3 rounded-[8px] border px-3 py-3 text-left transition-colors",
                      selected
                        ? "border-blue-300 bg-blue-50"
                        : "border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50/60",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <TokenLogo token={token} size="md" />
                      <span className="min-w-0">
                        <span className="block truncate text-base font-semibold text-slate-950">
                          {token.symbol}
                        </span>
                        <span className="block truncate text-sm text-slate-500">
                          {token.name}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-mono text-sm font-semibold text-slate-900">
                        {fmtBalance(token.balanceFormatted)} {token.symbol}
                      </span>
                      <span className={`block text-xs font-medium ${(token.valueUSD ?? 0) > 0 ? "text-emerald-600" : "text-slate-400"}`}>
                        {fmtUSD(token.valueUSD)}
                      </span>
                    </span>
                  </button>
                );
              })}

              {mode === "multi" && visibleUnavailable.length > 0 ? (
                <div className="pt-3">
                  <p className="mb-2 text-sm font-medium text-slate-500">Unavailable</p>
                  <div className="space-y-2">
                    {visibleUnavailable.map((token) => (
                      <div
                        key={token.address}
                        className="flex items-center justify-between gap-3 rounded-[8px] border border-slate-200 bg-slate-50 px-3 py-3 opacity-75"
                        title={reasonText(token.reason)}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <TokenLogo token={token} size="md" muted />
                          <span className="min-w-0">
                            <span className="block truncate text-base font-semibold text-slate-600">
                              {token.symbol}
                            </span>
                            <span className="block truncate text-sm text-slate-400">
                              {reasonText(token.reason)}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-mono text-base text-slate-600">
                            {token.balanceFormatted}
                          </span>
                          <span className="block text-sm text-slate-400">
                            ${token.valueUSD.toFixed(2)}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {list.length === 0 && visibleUnavailable.length === 0 ? (
                <div className="rounded-[8px] border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
                  No tokens found
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
