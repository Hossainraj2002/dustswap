"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyReferralCode, clearPointsSummaryCache, previewReferralCode } from "@/lib/points";
import { normalizeReferralCode, storePendingReferralCode } from "@/lib/referrals";
import { emitDataInvalidation } from "@/lib/clientEvents";

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

  // autofocus input after mount animation
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 350);
    return () => window.clearTimeout(t);
  }, []);

  // debounced preview validation
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const trimmed = code.trim();
    if (!trimmed) {
      setValidation({ status: "idle" });
      return;
    }

    if (trimmed.length < 4) {
      return;
    }

    setValidation({ status: "validating" });

    debounceRef.current = setTimeout(async () => {
      try {
        const result = await previewReferralCode(address, trimmed);
        if (result.valid) {
          setValidation({ status: "valid", message: result.message || "Valid code!" });
        } else {
          setValidation({ status: "invalid", message: result.message || "Invalid code." });
        }
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
    if (e.key === "Escape") onDismiss();
  };

  const trimmedCode = code.trim();
  const canApply = trimmedCode.length > 0 && !isApplying && !applySuccess;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center px-4 pb-8 sm:pb-0"
      style={{ background: "rgba(15,23,42,0.38)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      {/* backdrop blur */}
      <div className="absolute inset-0 backdrop-blur-[3px]" aria-hidden="true" />

      <div
        className="relative w-full max-w-[360px] overflow-hidden rounded-[32px] border border-white/80 shadow-[0_32px_80px_rgba(15,23,42,0.26),inset_0_1px_0_rgba(255,255,255,0.92)]"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(239,246,255,0.97) 100%)",
          animation: "referral-modal-in 0.28s cubic-bezier(0.34,1.56,0.64,1) both",
        }}
      >
        {/* top accent bar */}
        <div
          className="h-[3px] w-full"
          style={{
            background: "linear-gradient(90deg, #0ea5e9, #6366f1, #22c55e)",
          }}
        />

        <div className="px-6 pt-5 pb-6">
          {/* eyebrow */}
          <p className="text-center text-[10px] font-black uppercase tracking-[0.3em] text-sky-600">
            Referral Bonus
          </p>

          {/* headline */}
          <h2 className="mt-2 text-center text-[22px] font-black tracking-[-0.04em] text-slate-950">
            Have a referral code?
          </h2>

          {/* reward pill */}
          <div className="mt-3 flex justify-center">
            <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <p className="text-[11px] font-black tracking-[0.04em] text-emerald-700">
                +500 PP for you &amp; your referrer
              </p>
            </div>
          </div>

          {/* subtext */}
          <p className="mt-3 text-center text-[12.5px] leading-[1.6] text-slate-500">
            Enter a valid referral code to unlock{" "}
            <span className="font-bold text-slate-700">500 PP</span>.{" "}
            Both you and the person who referred you receive the reward.
          </p>

          {/* success state */}
          {applySuccess ? (
            <div className="mt-5 flex flex-col items-center gap-2">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50">
                <svg className="h-7 w-7 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-black text-emerald-700">Referral applied! +500 PP incoming.</p>
            </div>
          ) : (
            <>
              {/* input */}
              <div className="mt-5">
                <p className="mb-1.5 text-[10px] font-black uppercase tracking-[0.26em] text-slate-400">
                  Referral Code
                </p>
                <div className="relative">
                  <input
                    ref={inputRef}
                    type="text"
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.toUpperCase());
                      setApplyError(null);
                      setApplyInfo(null);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="e.g. DUST-XXXXX"
                    maxLength={32}
                    disabled={isApplying}
                    className={`w-full rounded-[16px] border px-4 py-3 font-mono text-sm font-bold tracking-[0.06em] text-slate-800 outline-none transition-all placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-300 ${
                      validation.status === "valid"
                        ? "border-emerald-300 bg-emerald-50/60 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200"
                        : validation.status === "invalid"
                          ? "border-rose-300 bg-rose-50/60 focus:border-rose-400 focus:ring-2 focus:ring-rose-200"
                          : "border-slate-200 bg-white focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    }`}
                  />
                  {/* validation icon */}
                  {validation.status === "validating" && (
                    <div className="absolute right-3.5 top-1/2 -translate-y-1/2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-sky-500" />
                    </div>
                  )}
                  {validation.status === "valid" && (
                    <div className="absolute right-3.5 top-1/2 -translate-y-1/2">
                      <svg className="h-4 w-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                  {validation.status === "invalid" && (
                    <div className="absolute right-3.5 top-1/2 -translate-y-1/2">
                      <svg className="h-4 w-4 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* validation message */}
                {(validation.status === "valid" || validation.status === "invalid") && (
                  <p
                    className={`mt-1.5 text-[11px] font-semibold ${
                      validation.status === "valid" ? "text-emerald-600" : "text-rose-600"
                    }`}
                  >
                    {validation.status === "valid"
                      ? (validation as { status: "valid"; message: string }).message
                      : (validation as { status: "invalid"; message: string }).message}
                  </p>
                )}

                {applyInfo && (
                  <p className="mt-1.5 text-[11px] font-semibold text-sky-600">{applyInfo}</p>
                )}

                {/* apply error */}
                {applyError && (
                  <p className="mt-1.5 text-[11px] font-semibold text-rose-600">{applyError}</p>
                )}
              </div>

              {/* CTA buttons */}
              <div className="mt-4 flex gap-2.5">
                <button
                  type="button"
                  onClick={onDismiss}
                  className="flex-1 rounded-[16px] border border-slate-200 bg-white py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50 active:scale-[0.98]"
                >
                  Maybe Later
                </button>
                <button
                  type="button"
                  onClick={() => void handleApply()}
                  disabled={!canApply}
                  className={`flex-1 rounded-[16px] py-2.5 text-sm font-black text-white shadow-[0_8px_20px_rgba(14,165,233,0.22)] transition active:scale-[0.98] ${
                    canApply
                      ? "bg-[linear-gradient(135deg,#0ea5e9,#6366f1)] hover:shadow-[0_12px_28px_rgba(14,165,233,0.32)] hover:-translate-y-0.5"
                      : "cursor-not-allowed bg-slate-200 text-slate-400 shadow-none"
                  }`}
                >
                  {isApplying ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      Applying…
                    </span>
                  ) : (
                    "Apply Code"
                  )}
                </button>
              </div>

              {/* footer hint */}
              <p className="mt-3 text-center text-[11px] text-slate-400">
                You can also enter a code later from your profile.
              </p>
            </>
          )}
        </div>
      </div>

      {/* animation keyframes injected inline */}
      <style>{`
        @keyframes referral-modal-in {
          from { opacity: 0; transform: scale(0.92) translateY(16px); }
          to   { opacity: 1; transform: scale(1)    translateY(0px); }
        }
      `}</style>
    </div>
  );
}
