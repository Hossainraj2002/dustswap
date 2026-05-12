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
    visualState.state === "signing" ||
    visualState.state === "pending";
  const isSuccess = visualState.state === "success" && txHash;
  const isPreview = visualState.state === "preview";

  if (isSuccess) {
    return (
      <a
        href={`https://basescan.org/tx/${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 text-base font-bold text-white shadow-[0_8px_24px_rgba(16,185,129,0.3)] transition-all hover:bg-emerald-600 hover:shadow-[0_12px_32px_rgba(16,185,129,0.4)]"
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
        "flex min-h-[52px] w-full items-center justify-center gap-2.5 rounded-2xl px-4 text-base font-bold transition-all",
        isPreview
          ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-[0_8px_24px_rgba(37,99,235,0.32)] hover:-translate-y-0.5 hover:shadow-[0_12px_32px_rgba(37,99,235,0.4)]"
          : visualState.state === "ready"
            ? "bg-blue-600 text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] hover:-translate-y-0.5 hover:bg-blue-700 hover:shadow-[0_12px_32px_rgba(37,99,235,0.36)]"
            : visualState.state === "error"
              ? "bg-red-500 text-white shadow-[0_8px_24px_rgba(239,68,68,0.24)] hover:bg-red-600"
              : visualState.state === "loading" || isBusy
                ? "cursor-wait bg-blue-500 text-white opacity-90"
                : "cursor-not-allowed bg-slate-100 text-slate-400",
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
      ) : (
        visualState.label
      )}
    </button>
  );
}
