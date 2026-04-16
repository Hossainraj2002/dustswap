"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useEffect, useMemo, useState } from "react";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { applyReferralCode } from "@/lib/points";
import {
  clearReferralAttemptedSession,
  clearReferralTerminalSession,
  clearPendingReferralCode,
  hasReferralAttemptedSession,
  hasReferralTerminalSession,
  isTerminalReferralError,
  markReferralAttemptedSession,
  markReferralTerminalSession,
  normalizeReferralCode,
  storePendingReferralCode,
} from "@/lib/referrals";

type ReferralPageClientProps = {
  params: Promise<{
    code: string;
  }>;
};

type ApplyState = "idle" | "applying" | "success" | "error";

export function ReferralPageClient({ params }: ReferralPageClientProps) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [referralCode, setReferralCode] = useState("");
  const [state, setState] = useState<ApplyState>("idle");
  const [message, setMessage] = useState(
    "Connect your wallet to activate this referral code."
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;

    params.then((resolved) => {
      if (!active) {
        return;
      }

      const normalized = normalizeReferralCode(decodeURIComponent(resolved.code));
      setReferralCode(normalized);
      storePendingReferralCode(normalized);
    });

    return () => {
      active = false;
    };
  }, [params]);

  useEffect(() => {
    if (!address || !referralCode) {
      return;
    }

    if (hasReferralTerminalSession(address, referralCode)) {
      return;
    }

    if (attempt === 0 && hasReferralAttemptedSession(address, referralCode)) {
      return;
    }

    let cancelled = false;
    markReferralAttemptedSession(address, referralCode);

    const run = async () => {
      setState("applying");
      setMessage("Applying your referral on-chain profile...");

      try {
        const result = await applyReferralCode(address, referralCode);
        if (cancelled) {
          return;
        }

        if (result.success) {
          markReferralTerminalSession(address, referralCode);
          clearPendingReferralCode();
          setState("success");
          setMessage("Referral linked. Your inviter now earns 20% of your future points.");
          if (typeof window !== "undefined") {
            window.localStorage.setItem(
              `dustswap:cofounder-pass-pending:${address.toLowerCase()}`,
              "pending"
            );
          }
          window.setTimeout(() => {
            router.replace("/profile");
          }, 1200);
          return;
        }

        if (isTerminalReferralError(result.error)) {
          markReferralTerminalSession(address, referralCode);
          clearPendingReferralCode();
        }

        setState("error");
        setMessage(result.error || "Referral could not be applied. Try again.");
      } catch {
        if (cancelled) {
          return;
        }

        setState("error");
        setMessage("Referral could not be applied. Try again.");
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [address, attempt, referralCode, router]);

  const toneClasses = useMemo(() => {
    if (state === "success") {
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    }

    if (state === "error") {
      return "border-rose-200 bg-rose-50 text-rose-700";
    }

    return "border-sky-200 bg-sky-50 text-sky-700";
  }, [state]);

  return (
    <div
      className="bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_22%),linear-gradient(180deg,#f8fafc,#fef7ed_45%,#eff6ff)] px-3 py-4 pb-16 sm:px-6 sm:py-8"
      style={{ minHeight: "calc(100dvh - 4rem)" }}
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3">
        <section className="rounded-[28px] border border-white/70 bg-white/88 p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)]">
          <p className="text-[10px] font-black uppercase tracking-[0.32em] text-slate-500">
            REFERRAL UNLOCK
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
            You&apos;ve been invited to join DustSwap
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Connect your wallet to activate this referral code.
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            When the invite is linked successfully, both you and the person who
            referred you receive 500 PP.
          </p>

          <div className="mt-4 rounded-[22px] border border-slate-200 bg-[#f8fbff] p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">
              INVITE CODE
            </p>
            <p className="mt-2 break-all font-mono text-lg font-black tracking-[0.18em] text-sky-700">
              {referralCode || "LOADING..."}
            </p>
          </div>

          <div className={`mt-4 rounded-[20px] border px-4 py-3 text-sm ${toneClasses}`}>
            {message}
          </div>

          <div className="mt-5 flex flex-col gap-3">
            {!isConnected ? (
              <div className="rounded-[22px] border border-slate-200 bg-[#fffdf7] p-4 text-center">
                <div className="flex justify-center">
                  <WalletConnectButton
                    className="bg-[linear-gradient(135deg,#0ea5e9,#22c55e)] text-white shadow-[0_14px_32px_rgba(14,165,233,0.18)] hover:border-transparent hover:bg-[linear-gradient(135deg,#0284c7,#16a34a)] hover:text-white"
                    description="Connect your wallet to activate this referral code."
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-[22px] border border-slate-200 bg-[#fffdf7] p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">
                  Connected Wallet
                </p>
                <p className="mt-2 break-all text-sm font-semibold text-slate-800">{address}</p>
              </div>
            )}

            {state === "error" ? (
              <button
                type="button"
                onClick={() => {
                  if (!address || !referralCode) {
                    return;
                  }

                  clearReferralAttemptedSession(address, referralCode);
                  clearReferralTerminalSession(address, referralCode);
                  setAttempt((current) => current + 1);
                }}
                disabled={!isConnected}
                className="rounded-[18px] bg-[linear-gradient(135deg,#0ea5e9,#22c55e)] px-4 py-3 text-sm font-black text-white shadow-[0_14px_32px_rgba(14,165,233,0.18)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Retry Referral Apply
              </button>
            ) : null}

            <Link
              href="/profile"
              className="rounded-[18px] border border-slate-300/70 bg-white/70 px-4 py-3 text-center text-sm font-semibold text-slate-600 transition hover:bg-white hover:text-slate-900"
            >
              Open Profile
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
