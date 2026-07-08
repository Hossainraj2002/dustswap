"use client";

import { useMemo, useState } from "react";
import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type SweepChain } from "@/config/sweepChainConfig";
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
  if (token.name && token.name !== token.symbol) return token.name;
  if (token.status === "LIQUIDITY_PENDING") return "Quote pending";
  if (token.status === "PRICED") return token.priceConfidence === "HIGH" ? "High confidence" : "Priced";
  if (token.status === "UNKNOWN_PRICE") return "No price";
  if (token.status === "HIDDEN") return "Hidden";
  if (token.status === "SPAM") return "Blocked";
  return token.name;
}

// Small confidence dot colour, mirroring discoveryBadge. Hidden when muted.
function confidenceDot(token: Token, mutedReason?: string) {
  if (mutedReason) return null;
  if (token.status === "PRICED") {
    return token.priceConfidence === "HIGH" ? "bg-emerald-500" : "bg-blue-500";
  }
  if (token.status === "LIQUIDITY_PENDING") return "bg-amber-500";
  if (token.status === "UNKNOWN_PRICE" || token.status === "HIDDEN") return "bg-slate-300 dark:bg-slate-600";
  if (token.status === "SPAM") return "bg-red-400";
  return "bg-slate-300 dark:bg-slate-600";
}

const CHAIN_ICON: Record<string, string> = {
  base: BASE_ICON,
  ethereum:
    "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
};

function NetworkRow({
  chains,
  activeChainId,
  onChainChange,
  disabled,
}: {
  chains: SweepChain[];
  activeChainId: number;
  onChainChange: (chainId: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {chains.map((chain) => {
        const active = chain.id === activeChainId;
        return (
          <button
            key={chain.id}
            type="button"
            aria-pressed={active}
            disabled={disabled && !active}
            onClick={() => {
              if (!active) onChainChange(chain.id);
            }}
            className={cx(
              "inline-flex h-11 items-center gap-2 rounded-[13px] px-3.5 text-[15px] transition disabled:opacity-50",
              active
                ? "border-[1.5px] border-[#0052ff] bg-blue-50 font-bold text-slate-900 shadow-[0_1px_2px_rgba(16,24,40,0.05)] dark:bg-blue-400/10 dark:text-white"
                : "border border-slate-300 font-semibold text-slate-500 hover:border-blue-300 hover:text-slate-900 dark:border-white/15 dark:text-slate-400 dark:hover:text-white",
            )}
          >
            {CHAIN_ICON[chain.key] ? (
              <img src={CHAIN_ICON[chain.key]} alt={chain.label} className="h-5 w-5 rounded-full" />
            ) : null}
            {chain.label}
          </button>
        );
      })}
    </div>
  );
}

function AssetRow({
  token,
  selected,
  disabled,
  mutedReason,
  multi,
  onClick,
}: {
  token: Token & Partial<Pick<SwappableToken, "balanceFormatted" | "valueUSD">>;
  selected?: boolean;
  disabled?: boolean;
  mutedReason?: string;
  multi?: boolean;
  onClick?: () => void;
}) {
  const balance = fmtBalance(token.balanceFormatted);
  const usd = fmtUSD(token.valueUSD);
  const subtitle = discoveryBadge(token, mutedReason);
  const dot = confidenceDot(token, mutedReason);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={mutedReason}
      className={cx(
        "group flex min-h-[60px] w-full items-center justify-between gap-3 rounded-[12px] px-2.5 py-2 text-left transition",
        selected && "bg-blue-50 ring-1 ring-blue-300 dark:bg-blue-400/10 dark:ring-blue-400/30",
        !selected && !disabled && "hover:bg-slate-50 dark:hover:bg-white/[0.04]",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        <TokenLogo token={token} size="md" muted={disabled} />
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-bold text-slate-900 dark:text-white">{token.symbol}</span>
          <span className="flex items-center gap-1.5">
            {dot ? <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", dot)} /> : null}
            <span className="block truncate text-[13px] text-slate-500 dark:text-slate-400">{subtitle}</span>
          </span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2.5">
        <span className="text-right">
          <span className="block font-mono text-sm font-semibold tabular-nums text-slate-900 dark:text-white">{balance}</span>
          <span className="block text-xs text-slate-400 dark:text-slate-500">{usd}</span>
        </span>
        {multi && !disabled ? (
          <span
            className={cx(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition",
              selected
                ? "border-[#0052ff] bg-[#0052ff] text-white"
                : "border-slate-300 text-transparent group-hover:border-slate-400 dark:border-white/20",
            )}
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 13l4 4L19 7" />
            </svg>
          </span>
        ) : null}
      </span>
    </button>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="sweep-skel h-9 w-9 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <span className="sweep-skel block h-3 w-1/3 rounded" />
          <span className="sweep-skel mt-2 block h-2.5 w-1/2 rounded" />
        </div>
      </div>
      <div className="text-right">
        <span className="sweep-skel ml-auto block h-3 w-12 rounded" />
        <span className="sweep-skel ml-auto mt-2 block h-2.5 w-8 rounded" />
      </div>
    </div>
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
  routeMaxCap,
  enabledChains,
  chainId,
  onChainChange,
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
  routeMaxCap: number;
  enabledChains: SweepChain[];
  chainId: number;
  onChainChange: (chainId: number) => void;
}) {
  const activeChain = enabledChains.find((chain) => chain.id === chainId) ?? enabledChains[0];
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(
    () => new Set(selectedTokens.map((token) => token.address.toLowerCase())),
    [selectedTokens],
  );
  // At the per-wallet selection ceiling: block selecting NEW tokens (already-selected rows
  // stay clickable so the user can still deselect). routeMaxCap already reflects the
  // wallet-specific limit from the hook.
  const atSelectionCap = mode === "multi" && selectedTokens.length >= routeMaxCap;

  const disabledOutputToken =
    mode === "multi" &&
    selectedOutputToken &&
    !selectedOutputToken.isNative &&
    tokenMatchesSearch(selectedOutputToken, query)
      ? selectedOutputToken
      : null;
  const disabledOutputAddress = disabledOutputToken?.address.toLowerCase() ?? null;

  const visibleSwappable = useMemo(
    () =>
      swappableTokens
        .filter(
          (token) =>
            tokenMatchesSearch(token, query) &&
            token.address.toLowerCase() !== disabledOutputAddress,
        )
        .sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0)),
    [disabledOutputAddress, query, swappableTokens],
  );
  const visibleOutputTokens = useMemo(
    () => outputTokens.filter((token) => tokenMatchesSearch(token, query)),
    [outputTokens, query],
  );
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
      <div className="flex max-h-[86dvh] w-full max-w-[540px] flex-col rounded-t-[24px] bg-white shadow-[0_30px_90px_rgba(15,23,42,0.28)] dark:bg-[#0b1220] sm:rounded-[24px]">
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <h2 className="text-xl font-bold tracking-[-0.01em] text-slate-950 dark:text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-[11px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Close token selector"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 pb-5">
          <div className="relative">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search for a token or paste address"
              className="h-11 w-full rounded-[13px] border border-slate-200 bg-slate-50 px-4 pr-11 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-500/10 dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:focus:bg-white/[0.06]"
            />
            <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400">
              <SearchIcon />
            </span>
          </div>

          <NetworkRow
            chains={enabledChains}
            activeChainId={chainId}
            onChainChange={onChainChange}
            disabled={isScanning}
          />

          {mode === "single" ? (
            <div>
              <p className="mb-2 text-[13px] font-semibold text-slate-500 dark:text-slate-400">Popular tokens</p>
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
                      "inline-flex min-h-[36px] items-center gap-1.5 rounded-[11px] border px-3 text-sm font-bold transition",
                      selectedOutputToken?.address.toLowerCase() === token.address.toLowerCase()
                        ? "border-[#0052ff] bg-blue-50 text-[#0052ff] dark:bg-blue-400/10 dark:text-blue-300"
                        : "sweep-chip text-slate-800 hover:border-blue-300 dark:text-slate-100",
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
              <p className="text-[13px] font-semibold text-slate-500 dark:text-slate-400">
                {mode === "single" ? "Your tokens" : activeChain?.label ?? "Base"}
                {mode === "multi" ? (
                  <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
                    {visibleSwappable.length} sweepable / {discoveryLabel}
                  </span>
                ) : null}
              </p>
              {mode === "multi" && atSelectionCap ? (
                <span className="rounded-[9px] bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-600 dark:bg-amber-400/10 dark:text-amber-300">
                  Max {routeMaxCap} reached
                </span>
              ) : mode === "multi" && visibleSwappable.length > 0 ? (
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="min-h-0 rounded-[9px] px-2 py-1 text-sm font-semibold text-[#0052ff] transition hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-400/10"
                >
                  Select all
                </button>
              ) : null}
            </div>

            <div className="space-y-0.5">
              {disabledOutputToken ? (
                <AssetRow token={disabledOutputToken} disabled mutedReason="Selected output token" />
              ) : null}

              {(mode === "single" ? visibleOutputTokens : visibleSwappable).map((token) => {
                const selected =
                  mode === "single"
                    ? selectedOutputToken?.address.toLowerCase() === token.address.toLowerCase()
                    : selectedSet.has(token.address.toLowerCase());
                // At the cap, only NEW (unselected) tokens are blocked — selected rows stay
                // tappable so the user can still deselect to make room.
                const rowDisabled = !selected && atSelectionCap;

                return (
                  <AssetRow
                    key={token.address}
                    token={token}
                    selected={selected}
                    multi={mode === "multi"}
                    disabled={rowDisabled}
                    onClick={() => {
                      if (mode === "single") {
                        onSelectOutputToken(token);
                        onClose();
                      } else {
                        if (selected) {
                          onRemoveToken(token.address);
                        } else {
                          if (rowDisabled) return;
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
                    <p className="text-[13px] font-semibold text-slate-500 dark:text-slate-400">
                      Hidden / unavailable
                      <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">{visibleUnavailable.length} tokens</span>
                    </p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">
                      Below $0.01, no price, output assets, native ETH, or risk-filtered.
                    </p>
                  </div>
                  <div className="space-y-0.5">
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
                isScanning && !query.trim() ? (
                  <div className="space-y-0.5">
                    {Array.from({ length: 6 }).map((_, index) => (
                      <SkeletonRow key={index} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[14px] border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
                    No tokens found
                  </div>
                )
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
