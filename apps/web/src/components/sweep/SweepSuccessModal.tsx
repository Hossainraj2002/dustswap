"use client";

import { useEffect } from "react";
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
      maximumFractionDigits: value >= 1 ? 8 : 10,
    });
  } catch {
    return "0";
  }
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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
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

function CheckBadge() {
  return (
    <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
      <span className="absolute left-0 top-4 h-1.5 w-1.5 rounded-full bg-emerald-400" />
      <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-teal-400" />
      <span className="absolute bottom-2 right-0 h-1.5 w-1.5 rounded-full bg-emerald-300" />
      <span className="absolute left-3 bottom-0 h-1 w-1 rounded-full bg-cyan-400" />
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-[0_14px_34px_rgba(16,185,129,0.32)]">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-8 w-8">
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
    </div>
  );
}

function FlowGraphic({ summary }: { summary: DustSweepCompletionSummary }) {
  const visibleInputs = summary.inputs.slice(0, 3);
  const hiddenCount = Math.max(0, summary.routeCount - visibleInputs.length);

  return (
    <div className="rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-4 shadow-inner">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center">
          {visibleInputs.map((token, index) => (
            <span
              key={token.address}
              className={cx(
                "relative inline-flex rounded-full border-2 border-white bg-white shadow-sm",
                index > 0 && "-ml-2",
              )}
              title={token.symbol}
            >
              <TokenLogo token={token} size="sm" />
            </span>
          ))}
          {hiddenCount > 0 ? (
            <span className="-ml-2 inline-flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-white bg-slate-950 px-2 text-xs font-bold text-white shadow-sm">
              +{hiddenCount}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="h-1 w-3 rounded-full bg-slate-300" />
          <span className="h-1 w-3 rounded-full bg-slate-300" />
          <span className="h-1 w-3 rounded-full bg-slate-300" />
          <span className="h-1 w-5 rounded-full bg-blue-500" />
          <span className="h-1 w-5 rounded-full bg-emerald-400" />
          <span className="text-xl leading-none text-slate-500">-&gt;</span>
        </div>

        <div className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white px-2.5 py-1.5 text-slate-950 shadow-sm ring-1 ring-slate-200">
          <TokenLogo token={summary.tokenOut} size="sm" />
          <span className="pr-1 text-sm font-bold">{summary.tokenOut.symbol}</span>
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
  useEffect(() => {
    if (!summary) return;
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
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/25 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dustsweep-success-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-[540px] rounded-[8px] bg-white px-5 pb-5 pt-9 text-center shadow-[0_26px_90px_rgba(15,23,42,0.28)] sm:px-7 sm:pb-7">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-[8px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="Close sweep receipt"
        >
          <CloseIcon />
        </button>

        <CheckBadge />

        <h2 id="dustsweep-success-title" className="mt-5 text-2xl font-bold tracking-[-0.01em] text-slate-950">
          Sweep complete
        </h2>
        <p className="mt-3 text-sm font-medium text-slate-500">
          {summary.routeCount} token{summary.routeCount === 1 ? "" : "s"} converted through Dustswap at {completedTime}.
        </p>

        <div className="mt-8">
          <FlowGraphic summary={summary} />
        </div>

        <div className="mt-9">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">
            Received
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <span className="rounded-full bg-slate-100 p-1.5">
              <TokenLogo token={summary.tokenOut} size="sm" />
            </span>
            <p className="min-w-0 truncate font-mono text-[34px] font-bold leading-none text-slate-950 sm:text-[40px]">
              {outputAmount}
            </p>
            <span className="text-lg font-bold text-slate-800">{summary.tokenOut.symbol}</span>
          </div>
          <p className="mt-4 text-base font-bold text-emerald-600">
            {formatUsd(summary.tokenOutValueUSD)} estimated output
          </p>
        </div>

        <div className="mt-8 space-y-3">
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[56px] w-full items-center justify-center gap-3 rounded-[8px] bg-blue-600 px-4 text-lg font-bold text-white shadow-[0_14px_34px_rgba(37,99,235,0.28)] transition hover:bg-blue-700"
          >
            <ExternalLinkIcon />
            View on explorer
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[56px] w-full items-center justify-center rounded-[8px] border border-slate-200 px-4 text-base font-bold text-slate-950 transition hover:bg-slate-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
