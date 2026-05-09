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

export function SweepButton({
  visualState,
  onClick,
  txHash,
}: {
  visualState: SweepButtonVisualState;
  onClick: () => void;
  txHash: Hex | null;
}) {
  const disabled = visualState.state === "disabled" || visualState.state === "loading";
  const isBusy =
    visualState.state === "loading" ||
    visualState.state === "approving" ||
    visualState.state === "signing" ||
    visualState.state === "pending";
  const isSuccess = visualState.state === "success" && txHash;

  if (isSuccess) {
    return (
      <a
        href={`https://basescan.org/tx/${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="flex min-h-[48px] w-full items-center justify-center rounded-[8px] bg-green-600 px-4 text-base font-semibold text-white shadow-[0_12px_28px_rgba(22,163,74,0.22)] transition-colors hover:bg-green-700"
      >
        {visualState.label}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isBusy}
      className={cx(
        "flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[8px] px-4 text-base font-semibold transition-all",
        visualState.state === "ready"
          ? "bg-blue-600 text-white shadow-[0_12px_28px_rgba(37,99,235,0.24)] hover:-translate-y-0.5 hover:bg-blue-700"
          : visualState.state === "error"
            ? "bg-red-600 text-white hover:bg-red-700"
            : "bg-slate-200 text-slate-500",
      )}
    >
      {isBusy ? <Spinner /> : null}
      {visualState.label}
    </button>
  );
}
