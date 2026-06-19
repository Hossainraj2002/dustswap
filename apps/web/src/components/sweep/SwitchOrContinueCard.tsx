"use client";

import { useEffect, useRef, useState } from "react";

function BlueAlertIcon() {
  return (
    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
      !
    </span>
  );
}

/**
 * Route B — calm, inline "Set up with {wallet}" card that REPLACES the old red
 * "Wallet Not Supported" modal. Never blocks: switching is an optimization and
 * "Continue" always proceeds via Permit2. Focus moves to the heading when it
 * appears and Esc dismisses to the continue path (no focus trap).
 */
export function SwitchOrContinueCard({
  walletLabel,
  currentWalletName,
  onSwitch,
  onContinue,
}: {
  walletLabel: string;
  currentWalletName: string;
  onSwitch: () => void;
  onContinue: () => void;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onContinue();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onContinue]);

  return (
    <div
      role="region"
      aria-label={`This address is set up with ${walletLabel}`}
      className="rounded-[16px] border border-blue-200 bg-blue-50 p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-blue-400/20 dark:bg-blue-400/10"
    >
      <div className="flex items-start gap-3">
        <BlueAlertIcon />
        <div className="min-w-0 flex-1">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold text-slate-900 outline-none dark:text-white"
          >
            This address is set up with {walletLabel}
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-slate-700 dark:text-slate-300">
            For one-click batching of up to 50 tokens, connect with {walletLabel}.
            Prefer to stay on {currentWalletName}? You can sweep with a single
            signature + one transaction instead.
          </p>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={onSwitch}
              className="sweep-cta flex min-h-[44px] flex-1 items-center justify-center rounded-[13px] px-4 text-sm font-bold"
            >
              Switch to {walletLabel}
            </button>
            <button
              type="button"
              onClick={onContinue}
              className="flex min-h-[44px] flex-1 items-center justify-center rounded-[13px] border border-blue-300 bg-white px-4 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-50 dark:border-blue-400/30 dark:bg-transparent dark:text-blue-300 dark:hover:bg-blue-400/10"
            >
              Continue with {currentWalletName}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowWhy((value) => !value)}
            aria-expanded={showWhy}
            className="mt-3 flex items-center gap-1 text-xs font-medium text-blue-700/80 transition-colors hover:text-blue-800 dark:text-blue-300/80 dark:hover:text-blue-200"
          >
            <span aria-hidden="true">ⓘ</span> Why am I seeing this?
          </button>
          {showWhy ? (
            <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-400">
              Your wallet address was upgraded for batch transactions by{" "}
              {walletLabel}. Only one wallet can manage that at a time, so other
              wallets sweep with a signature instead. Nothing is wrong with your
              funds.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
