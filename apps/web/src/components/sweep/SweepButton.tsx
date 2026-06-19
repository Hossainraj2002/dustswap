"use client";

import { type Hex } from "viem";
import { type SweepButtonVisualState } from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Spinner() {
  return (
    <span
      className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    />
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]">
      <path
        fill="currentColor"
        d="M12 2.5l1.7 4.6a3 3 0 0 0 1.8 1.8L20 10.5l-4.5 1.6a3 3 0 0 0-1.8 1.8L12 18.5l-1.7-4.6a3 3 0 0 0-1.8-1.8L4 10.5l4.5-1.6a3 3 0 0 0 1.8-1.8L12 2.5z"
      />
      <path fill="currentColor" d="M18.5 14.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z" opacity="0.7" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
    </svg>
  );
}

export function SweepButton({
  visualState,
  onClick,
  txHash,
}: {
  visualState: SweepButtonVisualState;
  onClick: () => void;
  txHash: Hex | null;
}) {
  const disabled = visualState.state === "disabled";
  const isBusy =
    visualState.state === "loading" ||
    visualState.state === "approving" ||
    visualState.state === "setup" ||
    visualState.state === "signing" ||
    visualState.state === "pending";
  const isSuccess = visualState.state === "success" && txHash;
  const isPreview = visualState.state === "preview";
  const isPrimary = isPreview || visualState.state === "ready";

  if (isSuccess) {
    return (
      <a
        href={`https://basescan.org/tx/${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-[15px] bg-emerald-500 px-4 text-base font-bold text-white shadow-[0_14px_28px_-10px_rgba(16,185,129,0.55)] transition-all hover:bg-emerald-600"
      >
        <CheckIcon />
        {visualState.label}
        <ExternalLinkIcon />
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isBusy}
      className={cx(
        "flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-[15px] px-4 text-base font-bold transition-all",
        isPrimary
          ? "sweep-cta"
          : visualState.state === "error"
            ? "bg-red-500 text-white shadow-[0_14px_28px_-10px_rgba(239,68,68,0.5)] hover:bg-red-600"
            : isBusy
              ? "cursor-wait bg-blue-50 text-blue-500 dark:bg-blue-400/10 dark:text-blue-300"
              : "cursor-not-allowed bg-slate-100 text-slate-400 dark:bg-white/[0.06] dark:text-slate-500",
      )}
    >
      {isBusy ? <Spinner /> : null}
      {isPreview ? (
        <>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {visualState.label}
        </>
      ) : visualState.state === "ready" ? (
        <>
          <SparkleIcon />
          {visualState.label}
        </>
      ) : (
        visualState.label
      )}
    </button>
  );
}
