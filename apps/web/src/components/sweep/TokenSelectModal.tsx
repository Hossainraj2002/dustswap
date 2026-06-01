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

const BASE_ICON = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png";

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
  if (reason === "OUTPUT_ASSET") return "Output asset";
  if (reason === "UNKNOWN_PRICE") return "No price";
  if (reason === "SPAM_OR_DENYLISTED") return "Blocked token";
  return "Below threshold";
}

function fmtBalance(value: string | undefined) {
  const num = Number(value || "0");
  if (!Number.isFinite(num) || num === 0) return "";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  if (num >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (num >= 0.001) return num.toPrecision(6);
  return num.toExponential(2);
}

function fmtUSD(value: number | undefined) {
  const v = value ?? 0;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  if (v > 0) return "<$0.01";
  return "";
}

function discoveryBadge(token: Token, mutedReason?: string) {
  if (mutedReason) return mutedReason;
  if (token.status === "LIQUIDITY_PENDING") return "Quote pending";
  if (token.status === "PRICED") return token.priceConfidence === "HIGH" ? "High confidence" : "Priced";
  if (token.status === "UNKNOWN_PRICE") return "No price";
  if (token.status === "HIDDEN") return "Hidden";
  if (token.status === "SPAM") return "Blocked";
  return token.name;
}

function NetworkButton({
  active,
  label,
  icon,
}: {
  active?: boolean;
  label: string;
  icon?: string;
}) {
  return (
    <button
      type="button"
      className={cx(
        "flex h-[60px] w-[60px] items-center justify-center rounded-[8px] border transition",
        active
          ? "border-blue-500 bg-blue-50 shadow-sm"
          : "border-transparent bg-blue-50/70 hover:border-blue-200",
      )}
      title={label}
    >
      {icon ? <img src={icon} alt={label} className="h-8 w-8 rounded-[6px]" /> : (
        <span className="grid h-8 w-8 grid-cols-2 gap-1">
          <span className="rounded-[3px] bg-blue-700" />
          <span className="rounded-[3px] bg-slate-700" />
          <span className="rounded-[3px] bg-violet-600" />
          <span className="rounded-[3px] bg-emerald-600" />
        </span>
      )}
    </button>
  );
}

function AssetRow({
  token,
  selected,
  disabled,
  mutedReason,
  onClick,
}: {
  token: Token & Partial<Pick<SwappableToken, "balanceFormatted" | "valueUSD">>;
  selected?: boolean;
  disabled?: boolean;
  mutedReason?: string;
  onClick?: () => void;
}) {
  const balance = fmtBalance(token.balanceFormatted);
  const usd = fmtUSD(token.valueUSD);
  const subtitle = discoveryBadge(token, mutedReason);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={mutedReason}
      className={cx(
        "group flex min-h-[62px] w-full items-center justify-between gap-3 rounded-[8px] px-2 py-2 text-left transition",
        selected && "bg-blue-50 ring-1 ring-blue-300",
        !selected && !disabled && "hover:bg-blue-50",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        <TokenLogo token={token} size="md" muted={disabled} />
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold text-slate-950">{token.symbol}</span>
          <span className="block truncate text-sm text-slate-500">{subtitle}</span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-mono text-sm text-slate-950">{balance}</span>
        <span className="block text-xs text-slate-400">{usd}</span>
      </span>
    </button>
  );
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
  discoveredCount,
  isScanning,
  onSelectToken,
  onRemoveToken,
  onSelectOutputToken,
  onSelectAll,
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
  discoveredCount?: number;
  isScanning?: boolean;
  onSelectToken: (token: SwappableToken) => void;
  onRemoveToken: (address: string) => void;
  onSelectOutputToken: (token: Token) => void;
  onSelectAll: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(
    () => new Set(selectedTokens.map((token) => token.address.toLowerCase())),
    [selectedTokens],
  );

  const visibleSwappable = useMemo(
    () =>
      swappableTokens
        .filter((token) => tokenMatchesSearch(token, query))
        .sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0)),
    [query, swappableTokens],
  );
  const visibleOutputTokens = useMemo(
    () => outputTokens.filter((token) => tokenMatchesSearch(token, query)),
    [outputTokens, query],
  );

  const disabledOutputToken =
    mode === "multi" && selectedOutputToken && tokenMatchesSearch(selectedOutputToken, query)
      ? selectedOutputToken
      : null;
  const disabledOutputAddress = disabledOutputToken?.address.toLowerCase() ?? null;
  const visibleUnavailable = useMemo(
    () =>
      unavailableTokens.filter(
        (token) =>
          tokenMatchesSearch(token, query) &&
          token.address.toLowerCase() !== disabledOutputAddress,
      ),
    [disabledOutputAddress, query, unavailableTokens],
  );
  const visibleDiscoveredCount =
    visibleSwappable.length + visibleUnavailable.length + (disabledOutputToken ? 1 : 0);
  const walletBalanceCount = Math.max(discoveredCount ?? 0, visibleDiscoveredCount);
  const discoveryLabel = isScanning
    ? walletBalanceCount > 0
      ? `scanning ${walletBalanceCount} balances`
      : "scanning balances"
    : `${walletBalanceCount} balances scanned`;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/45 px-0 backdrop-blur-sm sm:items-center sm:px-4">
      <div className="flex max-h-[86dvh] w-full max-w-[540px] flex-col rounded-t-[8px] bg-white shadow-[0_30px_80px_rgba(15,23,42,0.22)] sm:rounded-[8px]">
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-[8px] text-2xl font-light text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close token selector"
          >
            &times;
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 pb-5">
          <div className="relative">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search for a token or paste address"
              className="h-10 w-full rounded-[8px] border border-transparent bg-slate-50 px-4 pr-11 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:bg-white"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
              <SearchIcon />
            </span>
          </div>

          <div className="flex gap-3 overflow-x-auto pb-1">
            <NetworkButton active={mode === "single"} label="All" />
            <NetworkButton active={mode === "multi"} label="Base" icon={BASE_ICON} />
            <NetworkButton label="More networks" />
          </div>

          {mode === "single" ? (
            <div>
              <p className="mb-2 text-sm font-medium text-slate-500">Popular tokens:</p>
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
                      "inline-flex min-h-[34px] items-center gap-1.5 rounded-[7px] border px-2.5 text-sm font-semibold transition",
                      selectedOutputToken?.address.toLowerCase() === token.address.toLowerCase()
                        ? "border-blue-400 bg-blue-50 text-blue-700"
                        : "border-blue-100 bg-blue-50 text-slate-800 hover:border-blue-300",
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
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-slate-500">
                {mode === "single" ? "Your tokens" : "Base"}
                {mode === "multi" ? (
                  <span className="ml-2 text-xs text-slate-400">
                    {visibleSwappable.length} sweepable / {discoveryLabel}
                  </span>
                ) : null}
              </p>
              {mode === "multi" && visibleSwappable.length > 0 ? (
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="min-h-0 rounded-[6px] px-1.5 py-1 text-sm font-medium text-blue-700 transition hover:bg-blue-50"
                >
                  Select all
                </button>
              ) : null}
            </div>

            <div className="space-y-1">
              {disabledOutputToken ? (
                <AssetRow token={disabledOutputToken} disabled mutedReason="Selected output token" />
              ) : null}

              {(mode === "single" ? visibleOutputTokens : visibleSwappable).map((token) => {
                const selected =
                  mode === "single"
                    ? selectedOutputToken?.address.toLowerCase() === token.address.toLowerCase()
                    : selectedSet.has(token.address.toLowerCase());

                return (
                  <AssetRow
                    key={token.address}
                    token={token}
                    selected={selected}
                    onClick={() => {
                      if (mode === "single") {
                        onSelectOutputToken(token);
                        onClose();
                      } else {
                        if (selected) {
                          onRemoveToken(token.address);
                        } else {
                          onSelectToken(token as SwappableToken);
                        }
                      }
                    }}
                  />
                );
              })}

              {mode === "multi" && visibleUnavailable.length > 0 ? (
                <div className="pt-3">
                  <div className="mb-2">
                    <p className="text-sm font-medium text-slate-500">
                      Hidden / unavailable
                      <span className="ml-2 text-xs text-slate-400">{visibleUnavailable.length} tokens</span>
                    </p>
                    <p className="text-xs text-slate-400">
                      Below $0.01, no price, output assets, native ETH, or risk-filtered.
                    </p>
                  </div>
                  <div className="space-y-1">
                    {visibleUnavailable.map((token) => (
                      <AssetRow
                        key={token.address}
                        token={token}
                        disabled
                        mutedReason={reasonText(token.reason)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {visibleSwappable.length === 0 && visibleUnavailable.length === 0 && mode === "multi" ? (
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
