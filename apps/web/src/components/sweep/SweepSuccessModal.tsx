"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { TokenLogo } from "@/components/sweep/TokenLogo";
import { type DustSweepCompletionSummary } from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatUsd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTokenAmount(rawAmount: string, decimals: number) {
  try {
    const formatted = formatUnits(BigInt(rawAmount || "0"), decimals);
    const value = Number(formatted);
    if (!Number.isFinite(value)) return formatted;
    return value.toLocaleString(undefined, {
      maximumFractionDigits: value >= 1 ? 6 : 8,
    });
  } catch {
    return "0";
  }
}

function formatInputAmount(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return "0";
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 10_000) return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (amount >= 1) return amount.toLocaleString(undefined, { maximumFractionDigits: 5 });
  if (amount >= 0.0001) return amount.toLocaleString(undefined, { maximumFractionDigits: 8 });
  return amount.toExponential(2);
}

function formatDexName(dexName: string) {
  if (dexName.startsWith("UNISWAP")) return "Uniswap";
  if (dexName === "PANCAKESWAP_V3") return "PancakeSwap";
  if (dexName === "AERODROME") return "Aerodrome";
  if (dexName === "BASESWAP") return "BaseSwap";
  return dexName.replace(/_/g, " ");
}

function shortHash(hash: string) {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path
        d="M6 6l12 12M18 6 6 18"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CheckBadge() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-[8px] bg-emerald-500 text-white shadow-[0_12px_28px_rgba(16,185,129,0.28)]">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6">
        <path
          d="M5 13l4 4L19 7"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.5"
        />
      </svg>
    </span>
  );
}

function FlowGraphic({ summary }: { summary: DustSweepCompletionSummary }) {
  const visibleInputs = summary.inputs.slice(0, 4);
  const hiddenCount = Math.max(0, summary.inputs.length - visibleInputs.length);

  return (
    <div className="relative overflow-hidden rounded-[8px] border border-slate-200 bg-[linear-gradient(135deg,#f8fafc,#eef6ff_48%,#ecfdf5)] px-4 py-4">
      <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-blue-300 to-transparent" />
      <div className="relative flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center">
          {visibleInputs.map((token, index) => (
            <span
              key={token.address}
              className={cx(
                "relative inline-flex rounded-full border-2 border-white bg-white shadow-sm",
                index > 0 && "-ml-3",
              )}
              title={token.symbol}
            >
              <TokenLogo token={token} size="sm" />
            </span>
          ))}
          {hiddenCount > 0 ? (
            <span className="-ml-2 inline-flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-white bg-slate-900 px-1.5 text-[11px] font-bold text-white shadow-sm">
              +{hiddenCount}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 text-blue-600">
          <span className="h-1 w-6 rounded-full bg-blue-400" />
          <span className="h-1 w-3 rounded-full bg-emerald-400" />
          <span className="h-1 w-6 rounded-full bg-blue-400" />
        </div>

        <div className="flex shrink-0 items-center gap-2 rounded-full bg-slate-950 px-2 py-1 text-white shadow-sm">
          <TokenLogo token={summary.tokenOut} size="sm" />
          <span className="pr-1 text-sm font-semibold">{summary.tokenOut.symbol}</span>
        </div>
      </div>
    </div>
  );
}

export function SweepSuccessModal({
  summary,
  onClose,
}: {
  summary: DustSweepCompletionSummary | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!summary) return;
    setCopied(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, summary]);

  if (!summary) return null;

  const explorerUrl = `https://basescan.org/tx/${summary.txHash}`;
  const outputAmount = formatTokenAmount(summary.tokenOutAmount, summary.tokenOut.decimals);
  const completedTime = new Date(summary.completedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(summary.txHash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 px-3 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dustsweep-success-title"
    >
      <div className="relative max-h-[92vh] w-full max-w-[560px] overflow-y-auto rounded-[8px] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.28)]">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-[8px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="Close sweep receipt"
        >
          <CloseIcon />
        </button>

        <div className="bg-[linear-gradient(180deg,#f8fbff,#ffffff)] px-5 pb-4 pt-5 sm:px-6">
          <div className="flex items-start gap-3 pr-10">
            <CheckBadge />
            <div className="min-w-0">
              <p id="dustsweep-success-title" className="text-xl font-bold text-slate-950">
                Sweep complete
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {summary.routeCount} token{summary.routeCount === 1 ? "" : "s"} converted through {summary.walletName || "your wallet"} at {completedTime}.
              </p>
            </div>
          </div>

          <div className="mt-5">
            <FlowGraphic summary={summary} />
          </div>

          <div className="mt-5 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              Received
            </p>
            <div className="mt-2 flex items-center justify-center gap-2">
              <TokenLogo token={summary.tokenOut} size="md" />
              <p className="min-w-0 truncate font-mono text-3xl font-semibold leading-none text-slate-950 sm:text-4xl">
                {outputAmount}
              </p>
              <span className="text-lg font-bold text-slate-700">{summary.tokenOut.symbol}</span>
            </div>
            <p className="mt-2 text-sm font-medium text-emerald-700">
              {formatUsd(summary.tokenOutValueUSD)} estimated output
            </p>
          </div>
        </div>

        <div className="border-y border-slate-100 px-5 py-4 sm:px-6">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Input value</p>
              <p className="mt-1 text-sm font-bold text-slate-900">{formatUsd(summary.inputValueUSD)}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Fee</p>
              <p className="mt-1 text-sm font-bold text-slate-900">{formatUsd(summary.feeAmountUSD)}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Network</p>
              <p className="mt-1 text-sm font-bold text-slate-900">Base</p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4 sm:px-6">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">Tokens swept</p>
            <p className="text-xs font-medium text-slate-500">
              Gas about {formatUsd(summary.gasEstimateUSD)}
            </p>
          </div>

          <div className="max-h-[178px] overflow-y-auto rounded-[8px] border border-slate-100">
            {summary.inputs.map((token, index) => (
              <div
                key={`${token.address}-${index}`}
                className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2.5 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <TokenLogo token={token} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">
                      {formatInputAmount(token.balanceFormatted)} {token.symbol}
                    </p>
                    <p className="truncate text-xs text-slate-500">{formatDexName(token.dexName)}</p>
                  </div>
                </div>
                <p className="shrink-0 text-xs font-semibold text-slate-500">
                  {formatUsd(token.valueUSD || 0)}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 rounded-[8px] bg-slate-50 px-3 py-2">
            <span className="truncate font-mono text-xs font-semibold text-slate-600">
              {shortHash(summary.txHash)}
            </span>
            <button
              type="button"
              onClick={() => void copyHash()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-50"
            >
              <CopyIcon />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-4 text-base font-semibold text-white shadow-[0_12px_30px_rgba(37,99,235,0.24)] transition hover:bg-blue-700"
            >
              View on explorer
              <ExternalLinkIcon />
            </a>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-[44px] items-center justify-center rounded-[8px] border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
