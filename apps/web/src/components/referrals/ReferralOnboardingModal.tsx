"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { emitDataInvalidation } from "@/lib/clientEvents";
import { applyReferralCode, clearPointsSummaryCache, previewReferralCode } from "@/lib/points";
import { normalizeReferralCode, storePendingReferralCode } from "@/lib/referrals";

interface ReferralOnboardingModalProps {
  address: string;
  onApplied: () => void;
  onDismiss: () => void;
}

type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "valid"; message: string }
  | { status: "invalid"; message: string };

export function ReferralOnboardingModal({
  address,
  onApplied,
  onDismiss,
}: ReferralOnboardingModalProps) {
  const [code, setCode] = useState("");
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyInfo, setApplyInfo] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState(false);
  const [validation, setValidation] = useState<ValidationState>({ status: "idle" });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 250);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [onDismiss]);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const trimmed = code.trim();
    if (!trimmed || trimmed.length < 4) {
      setValidation({ status: "idle" });
      return;
    }

    setValidation({ status: "validating" });

    debounceRef.current = setTimeout(async () => {
      try {
        const result = await previewReferralCode(address, trimmed);
        setValidation(
          result.valid
            ? { status: "valid", message: result.message || "Valid code!" }
            : { status: "invalid", message: result.message || "Invalid code." }
        );
      } catch {
        setValidation({ status: "idle" });
      }
    }, 600);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [code, address]);

  const handleApply = useCallback(async () => {
    const trimmed = code.trim();
    if (!trimmed || isApplying) return;

    setIsApplying(true);
    setApplyError(null);
    setApplyInfo(null);

    try {
      const normalizedCode = normalizeReferralCode(trimmed);
      const result = await applyReferralCode(address, normalizedCode);

      if (!result.success) {
        if (result.deferred) {
          storePendingReferralCode(normalizedCode);
          clearPointsSummaryCache(address);
          setApplyInfo(
            "Invite code saved. It will activate after your first onchain check-in or PP claim."
          );

          window.setTimeout(() => {
            onApplied();
          }, 1200);
          return;
        }

        setApplyError(result.error || "Could not apply code. Try again.");
        return;
      }

      setApplySuccess(true);
      clearPointsSummaryCache(address);
      emitDataInvalidation(["leaderboard", "points"], "referral-applied");

      window.setTimeout(() => {
        onApplied();
      }, 1200);
    } catch {
      setApplyError("Something went wrong. Please try again.");
    } finally {
      setIsApplying(false);
    }
  }, [address, code, isApplying, onApplied]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void handleApply();
  };

  const trimmedCode = code.trim();
  const canApply = trimmedCode.length > 0 && !isApplying && !applySuccess;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 px-4 py-[calc(1rem+env(safe-area-inset-top))] backdrop-blur-sm dark:bg-black/65"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="referral-onboarding-title"
        className="relative flex min-h-0 overflow-hidden rounded-[20px] border shadow-[0_24px_70px_rgba(15,23,42,0.24)] dark:shadow-[0_28px_86px_rgba(0,0,0,0.5)]"
        style={{
          width: "min(6cm, calc(100vw - 2rem))",
          maxHeight:
            "calc(100dvh - 2rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
          background: "var(--ds-bg-elevated)",
          borderColor: "var(--ds-border-soft)",
          color: "var(--ds-text-primary)",
          animation: "referral-modal-in 0.22s ease-out both",
        }}
      >
        <div className="flex min-h-0 w-full flex-col">
          <div className="h-[3px] bg-[linear-gradient(90deg,#0ea5e9,#2563eb,#22c55e)]" />

          <button
            type="button"
            aria-label="Close referral bonus"
            onClick={onDismiss}
            className="absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/90 text-xl leading-none text-slate-500 shadow-sm transition hover:border-sky-200 hover:bg-sky-50 hover:text-slate-900 dark:border-white/10 dark:bg-white/[0.08] dark:text-slate-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
          >
            <span aria-hidden="true">&times;</span>
          </button>

          <div className="min-h-0 overflow-y-auto px-4 pb-4 pt-4">
            <div className="pr-10">
              <p className="text-[9px] font-black uppercase tracking-[0.24em] text-sky-600 dark:text-sky-300">
                Referral Bonus
              </p>
              <h2
                id="referral-onboarding-title"
                className="mt-1 text-base font-black tracking-tight text-slate-950 dark:text-white"
              >
                Add invite code
              </h2>
            </div>

            <div className="mt-3 rounded-[14px] border border-emerald-200 bg-emerald-50/90 px-3 py-2 dark:border-emerald-400/20 dark:bg-emerald-400/10">
              <p className="text-[11px] font-black leading-4 text-emerald-700 dark:text-emerald-300">
                +500 PP for both accounts
              </p>
              <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-300">
                Enter the referral code from your inviter.
              </p>
            </div>

            {applySuccess ? (
              <div className="mt-4 rounded-[14px] border border-emerald-200 bg-emerald-50 px-3 py-3 text-center dark:border-emerald-400/20 dark:bg-emerald-400/10">
                <svg
                  className="mx-auto h-7 w-7 text-emerald-500 dark:text-emerald-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
                <p className="mt-2 text-xs font-black text-emerald-700 dark:text-emerald-300">
                  Referral applied. +500 PP incoming.
                </p>
              </div>
            ) : (
              <>
                <div className="mt-4">
                  <label
                    htmlFor="referral-code"
                    className="mb-1.5 block text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500"
                  >
                    Referral Code
                  </label>
                  <div className="relative">
                    <input
                      id="referral-code"
                      ref={inputRef}
                      type="text"
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value.toUpperCase());
                        setApplyError(null);
                        setApplyInfo(null);
                      }}
                      onKeyDown={handleKeyDown}
                      placeholder="DUST-XXXXX"
                      maxLength={32}
                      disabled={isApplying}
                      className={`w-full rounded-[14px] border px-3 py-2.5 pr-9 font-mono text-[13px] font-bold tracking-[0.04em] outline-none transition placeholder:font-normal placeholder:tracking-normal disabled:cursor-not-allowed disabled:opacity-70 ${
                        validation.status === "valid"
                          ? "border-emerald-300 bg-emerald-50/70 text-emerald-950 placeholder:text-emerald-700/40 focus:ring-2 focus:ring-emerald-200 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-100 dark:focus:ring-emerald-400/20"
                          : validation.status === "invalid"
                            ? "border-rose-300 bg-rose-50/70 text-rose-950 placeholder:text-rose-700/40 focus:ring-2 focus:ring-rose-200 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100 dark:focus:ring-rose-400/20"
                            : "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-sky-300 focus:ring-2 focus:ring-sky-100 dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:placeholder:text-slate-500 dark:focus:border-sky-400 dark:focus:ring-sky-400/20"
                      }`}
                    />

                    {validation.status === "validating" && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-sky-500 dark:border-white/10 dark:border-t-sky-300" />
                      </div>
                    )}
                    {validation.status === "valid" && (
                      <svg
                        className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-500 dark:text-emerald-300"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {validation.status === "invalid" && (
                      <svg
                        className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-rose-500 dark:text-rose-300"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                  </div>

                  {(validation.status === "valid" || validation.status === "invalid") && (
                    <p
                      className={`mt-1.5 text-[11px] font-semibold leading-4 ${
                        validation.status === "valid"
                          ? "text-emerald-600 dark:text-emerald-300"
                          : "text-rose-600 dark:text-rose-300"
                      }`}
                    >
                      {validation.status === "valid"
                        ? (validation as { status: "valid"; message: string }).message
                        : (validation as { status: "invalid"; message: string }).message}
                    </p>
                  )}

                  {applyInfo && (
                    <p className="mt-1.5 text-[11px] font-semibold leading-4 text-sky-600 dark:text-sky-300">
                      {applyInfo}
                    </p>
                  )}

                  {applyError && (
                    <p className="mt-1.5 text-[11px] font-semibold leading-4 text-rose-600 dark:text-rose-300">
                      {applyError}
                    </p>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={() => void handleApply()}
                    disabled={!canApply}
                    className={`min-h-[42px] rounded-[14px] px-3 py-2 text-[13px] font-black transition active:scale-[0.98] ${
                      canApply
                        ? "bg-[linear-gradient(135deg,#0ea5e9,#2563eb)] text-white shadow-[0_10px_24px_rgba(37,99,235,0.22)] hover:-translate-y-0.5"
                        : "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400 shadow-none dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-500"
                    }`}
                  >
                    {isApplying ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                        Applying...
                      </span>
                    ) : (
                      "Apply Code"
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={onDismiss}
                    className="min-h-[42px] rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-[13px] font-bold text-slate-600 transition hover:bg-slate-50 active:scale-[0.98] dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-300 dark:hover:bg-white/[0.1]"
                  >
                    Maybe Later
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <style>{`
        @keyframes referral-modal-in {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
