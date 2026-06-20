"use client";

import { useCallback, useEffect, useState } from "react";
import { WALLET_LINKING_ENABLED } from "@/lib/dustsweep-feature-flags";
import { fetchLinkedWallets } from "@/lib/walletLinkAuth";

// One-time popup dismissal (banner stays as a persistent reminder).
const PROMO_DISMISS_KEY = "dustswap:wl-promo-dismissed:v1";
const MAX_WALLETS = 2;

const BENEFITS = [
  { icon: "🎁", text: "Instant 10,000 PP airdrop (one-time)" },
  { icon: "➕", text: "Both wallets' PP combine into one account" },
  { icon: "✅", text: "Check in from either wallet, spin tickets in both" },
  { icon: "⚡", text: "Earn onchain quest PP from both wallets" },
];

function hasDismissedPromo() {
  try {
    return window.localStorage.getItem(PROMO_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function markPromoDismissed() {
  try {
    window.localStorage.setItem(PROMO_DISMISS_KEY, "1");
  } catch {
    // ignore
  }
}

// Promotes wallet linking on the profile page with a one-time premium popup
// that routes into the profile settings → wallet-linking section. Self-gates:
// only shows when linking is enabled, a wallet is connected, and the account has
// not linked a second wallet yet (so the 10k PP reward is still claimable).
export function WalletLinkPromo({
  address,
  onOpenLinking,
}: {
  address?: string;
  onOpenLinking: () => void;
}) {
  const [eligible, setEligible] = useState(false);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!WALLET_LINKING_ENABLED || !address) {
      setEligible(false);
      setShowModal(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const { wallets } = await fetchLinkedWallets(address);
        if (cancelled) return;
        const canLink = (wallets?.length ?? 0) < MAX_WALLETS;
        setEligible(canLink);
        if (canLink && !hasDismissedPromo()) {
          setShowModal(true);
        }
      } catch {
        // Stay hidden on failure — never show a broken promo.
        if (!cancelled) setEligible(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address]);

  const openLinking = useCallback(() => {
    setShowModal(false);
    onOpenLinking();
  }, [onOpenLinking]);

  const claimFromModal = useCallback(() => {
    markPromoDismissed();
    openLinking();
  }, [openLinking]);

  const dismissModal = useCallback(() => {
    markPromoDismissed();
    setShowModal(false);
  }, []);

  if (!eligible) {
    return null;
  }

  return (
    <>
      {/* Premium popup — capped at 7cm tall */}
      {showModal ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center px-4">
          <button
            type="button"
            aria-label="Dismiss"
            className="absolute inset-0 cursor-default bg-slate-950/55 backdrop-blur-sm"
            onClick={dismissModal}
          />

          <section className="relative flex max-h-[7cm] w-full max-w-sm flex-col overflow-hidden rounded-[22px] border border-emerald-300/60 bg-[linear-gradient(160deg,#ffffff,#ecfdf5)] shadow-[0_30px_80px_rgba(5,150,105,0.35)] dark:border-emerald-400/20 dark:bg-[linear-gradient(160deg,#0b1220,#062a1d)]">
            <div className="flex items-start justify-between gap-2 px-4 pt-3">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.2em] text-white">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                  Live
                </span>
                <h2 className="mt-1.5 text-base font-black leading-tight tracking-tight text-emerald-950 dark:text-emerald-50">
                  Link your Base App wallet, get 10,000 PP
                </h2>
              </div>
              <button
                type="button"
                onClick={dismissModal}
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-white/80 text-emerald-700 transition hover:bg-white dark:border-emerald-400/20 dark:bg-white/5 dark:text-emerald-200"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-1 pt-1.5">
              <p className="text-[11px] leading-4 text-emerald-800/80 dark:text-emerald-200/70">
                Connect your Base App wallet to your DustSwap account and claim{" "}
                <span className="font-black text-emerald-700 dark:text-emerald-300">10,000 PP</span>{" "}
                instantly.
              </p>

              <ul className="mt-2 grid gap-1.5">
                {BENEFITS.map((benefit) => (
                  <li
                    key={benefit.text}
                    className="flex items-center gap-2 rounded-xl bg-white/70 px-2.5 py-1.5 text-[11px] font-semibold leading-tight text-emerald-950 dark:bg-white/[0.06] dark:text-emerald-50"
                  >
                    <span className="text-sm leading-none" aria-hidden="true">
                      {benefit.icon}
                    </span>
                    <span>{benefit.text}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="shrink-0 px-4 pb-3 pt-2">
              <button
                type="button"
                onClick={claimFromModal}
                className="w-full rounded-full bg-[linear-gradient(135deg,#059669,#22c55e)] px-4 py-2.5 text-sm font-black text-white shadow-[0_12px_26px_rgba(16,185,129,0.3)] transition hover:-translate-y-0.5"
              >
                Link wallet &amp; claim 10,000 PP
              </button>
              <button
                type="button"
                onClick={dismissModal}
                className="mt-1.5 w-full text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-700/60 transition hover:text-emerald-700 dark:text-emerald-300/50 dark:hover:text-emerald-300"
              >
                Maybe later
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
