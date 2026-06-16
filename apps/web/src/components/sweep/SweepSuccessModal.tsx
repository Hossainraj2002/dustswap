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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 sm:h-5 sm:w-5">
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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 sm:h-5 sm:w-5">
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
    <div className="relative mx-auto flex h-12 w-12 items-center justify-center sm:h-16 sm:w-16">
      <span className="absolute left-0 top-3 h-1.5 w-1.5 rounded-full bg-emerald-400 sm:top-4" />
      <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-teal-400" />
      <span className="absolute bottom-1.5 right-0 h-1.5 w-1.5 rounded-full bg-emerald-300 sm:bottom-2" />
      <span className="absolute bottom-0 left-2.5 h-1 w-1 rounded-full bg-cyan-400 sm:left-3" />
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500 text-white shadow-[0_14px_34px_rgba(16,185,129,0.32)] sm:h-14 sm:w-14">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6 sm:h-8 sm:w-8">
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

// Premium "dust stream" connector: a gradient rail with dust particles flowing
// into a glowing arrowhead — conveys many tokens being swept into the output.
function FlowConnector() {
  return (
    <span className="relative flex h-7 shrink-0 items-center sm:h-8" aria-hidden="true">
      <svg
        width="112"
        height="32"
        viewBox="0 0 112 32"
        fill="none"
        className="h-[26px] w-[76px] overflow-visible sm:h-8 sm:w-[112px]"
      >
        <defs>
          <linearGradient
            id="sweepFlowLine"
            x1="0"
            y1="16"
            x2="112"
            y2="16"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="45%" stopColor="#2563eb" />
            <stop offset="75%" stopColor="#06b6d4" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
          <radialGradient id="sweepFlowParticle" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="35%" stopColor="#5eead4" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* glow landing pad at the output end */}
        <circle cx="96" cy="16" r="10" fill="#10b981" opacity="0.12" />

        {/* soft rail */}
        <path
          d="M4 16H92"
          stroke="url(#sweepFlowLine)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeOpacity="0.16"
        />

        {/* flowing energy */}
        <path
          d="M4 16H92"
          stroke="url(#sweepFlowLine)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="0.5 9"
        >
          <animate
            attributeName="stroke-dashoffset"
            values="19;0"
            dur="1s"
            repeatCount="indefinite"
          />
        </path>

        {/* travelling dust particles */}
        <circle cy="16" r="3.5" fill="url(#sweepFlowParticle)">
          <animate attributeName="cx" values="4;90" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;1;1;0" dur="1.6s" repeatCount="indefinite" />
        </circle>
        <circle cy="16" r="2.5" fill="url(#sweepFlowParticle)">
          <animate attributeName="cx" values="4;90" dur="1.6s" begin="0.55s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;1;1;0" dur="1.6s" begin="0.55s" repeatCount="indefinite" />
        </circle>
        <circle cy="16" r="2" fill="url(#sweepFlowParticle)">
          <animate attributeName="cx" values="4;90" dur="1.6s" begin="1.1s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;1;1;0" dur="1.6s" begin="1.1s" repeatCount="indefinite" />
        </circle>

        {/* glowing arrowhead landing on the output token */}
        <path
          d="M90 9.5 102 16 90 22.5"
          stroke="#10b981"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </span>
  );
}

function FlowGraphic({ summary }: { summary: DustSweepCompletionSummary }) {
  const visibleInputs = summary.inputs.slice(0, 3);
  const hiddenCount = Math.max(0, summary.routeCount - visibleInputs.length);

  return (
    <div className="rounded-[8px] border border-slate-200 bg-slate-50 px-3 py-3 shadow-inner sm:px-4 sm:py-4">
      <div className="flex items-center justify-between gap-2 sm:gap-3">
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
            <span className="-ml-2 inline-flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-white bg-slate-950 px-2 text-[11px] font-bold text-white shadow-sm sm:h-8 sm:min-w-8 sm:text-xs">
              +{hiddenCount}
            </span>
          ) : null}
        </div>

        <FlowConnector />

        <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-2 py-1.5 text-slate-950 shadow-sm ring-1 ring-slate-200 sm:gap-2 sm:px-2.5">
          <TokenLogo token={summary.tokenOut} size="sm" />
          <span className="pr-0.5 text-xs font-bold sm:pr-1 sm:text-sm">{summary.tokenOut.symbol}</span>
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
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/25 px-3 pb-[calc(0.75rem+var(--safe-area-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-sm sm:px-4 sm:py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dustsweep-success-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative max-h-[calc(100dvh_-_1.5rem_-_env(safe-area-inset-top)_-_var(--safe-area-bottom))] w-full max-w-[350px] overflow-y-auto overscroll-contain rounded-[8px] bg-white px-4 pb-4 pt-7 text-center shadow-[0_26px_90px_rgba(15,23,42,0.28)] sm:max-h-[calc(100dvh_-_3rem)] sm:max-w-[540px] sm:px-7 sm:pb-7 sm:pt-9">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-[8px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 sm:right-5 sm:top-5 sm:h-9 sm:w-9"
          aria-label="Close sweep receipt"
        >
          <CloseIcon />
        </button>

        <CheckBadge />

        <h2 id="dustsweep-success-title" className="mt-3 text-xl font-bold text-slate-950 sm:mt-5 sm:text-2xl">
          Sweep complete
        </h2>
        <p className="mt-2 text-[13px] font-medium leading-snug text-slate-500 sm:mt-3 sm:text-sm">
          {summary.routeCount} token{summary.routeCount === 1 ? "" : "s"} converted through Dustswap at {completedTime}.
        </p>

        <div className="mt-5 sm:mt-8">
          <FlowGraphic summary={summary} />
        </div>

        <div className="mt-5 sm:mt-9">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400 sm:text-xs">
            Received
          </p>
          <div className="mt-3 flex items-center justify-center gap-2 sm:mt-4 sm:gap-3">
            <span className="rounded-full bg-slate-100 p-1 sm:p-1.5">
              <TokenLogo token={summary.tokenOut} size="sm" />
            </span>
            <p className="min-w-0 truncate font-mono text-[26px] font-bold leading-none text-slate-950 sm:text-[40px]">
              {outputAmount}
            </p>
            <span className="text-sm font-bold text-slate-800 sm:text-lg">{summary.tokenOut.symbol}</span>
          </div>
          <p className="mt-3 text-sm font-bold text-emerald-600 sm:mt-4 sm:text-base">
            {formatUsd(summary.tokenOutValueUSD)} estimated output
          </p>
        </div>

        <div className="mt-5 space-y-2 sm:mt-8 sm:space-y-3">
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[8px] bg-blue-600 px-3 text-base font-bold text-white shadow-[0_14px_34px_rgba(37,99,235,0.28)] transition hover:bg-blue-700 sm:min-h-[56px] sm:gap-3 sm:px-4 sm:text-lg"
          >
            <ExternalLinkIcon />
            View on explorer
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[46px] w-full items-center justify-center rounded-[8px] border border-slate-200 px-3 text-sm font-bold text-slate-950 transition hover:bg-slate-50 sm:min-h-[56px] sm:px-4 sm:text-base"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
