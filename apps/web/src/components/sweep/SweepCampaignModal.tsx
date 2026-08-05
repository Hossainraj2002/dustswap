"use client";

import { useEffect, useRef, useState } from "react";
import { useSignMessage } from "wagmi";
import type { Hex } from "viem";
import {
  buildCampaignClaimMessage,
  claimCampaignTier,
  formatCampaignPp,
  formatCampaignUsd,
  getCampaignDaysLeft,
  type CampaignStatus,
  type CampaignTierState,
} from "@/lib/sweepCampaign";

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M4.5 6.5V5a3.5 3.5 0 1 1 7 0v1.5m-8 0h9a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="m3.5 8.5 3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Campaign times are always shown in UTC, never the viewer's local timezone.
 * The campaign window is a single global deadline, so every user must read the
 * same clock: a local rendering would show different dates in different
 * countries for the same instant.
 */
function formatUtc(iso: string) {
  return `${new Date(iso).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })} UTC`;
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
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

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

function TierRow({
  tier,
  isClaiming,
  payoutsAvailable,
  onClaim,
}: {
  tier: CampaignTierState;
  isClaiming: boolean;
  payoutsAvailable: boolean;
  onClaim: (tier: number) => void;
}) {
  const isPaid = tier.status === "paid";
  const isClaimable = tier.status === "claimable";
  const isProcessing = tier.status === "processing";

  return (
    <div
      className={`flex items-center gap-3 rounded-[14px] border px-3 py-2.5 transition ${
        isPaid
          ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-400/25 dark:bg-emerald-400/[0.07]"
          : isClaimable
            ? "border-[#0052ff]/35 bg-blue-50/60 dark:border-[#3b82f6]/40 dark:bg-[#3b82f6]/[0.08]"
            : "border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.03]"
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-black ${
          isPaid
            ? "bg-emerald-500 text-white"
            : isClaimable
              ? "bg-[#0052ff] text-white"
              : "bg-slate-100 text-slate-400 dark:bg-white/10 dark:text-slate-500"
        }`}
      >
        {isPaid ? <CheckIcon /> : tier.tier}
      </span>

      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-bold text-slate-900 dark:text-white">
          Sweep {formatCampaignUsd(tier.thresholdUsd)}
        </span>
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
          Reward: {formatCampaignUsd(tier.rewardUsdc)} USDC
        </span>
      </span>

      <span className="ml-auto shrink-0">
        {isClaimable && !payoutsAvailable ? (
          // Reward delivery is briefly unavailable. Show a calm, neutral state
          // instead of a claim that would fail, and never hint at why.
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
            Opening soon
          </span>
        ) : isClaimable ? (
          <button
            type="button"
            disabled={isClaiming}
            onClick={() => onClaim(tier.tier)}
            className="sweep-cta inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-[10px] px-3.5 text-[12px] font-bold disabled:opacity-60"
          >
            {isClaiming ? <Spinner /> : null}
            {isClaiming ? "Signing" : `Claim $${tier.rewardUsdc}`}
          </button>
        ) : isProcessing ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-bold text-sky-700 dark:bg-sky-400/15 dark:text-sky-300">
            {payoutsAvailable ? <Spinner /> : null}
            {payoutsAvailable ? "Sending" : "Queued"}
          </span>
        ) : isPaid ? (
          tier.payoutTxHash ? (
            <a
              href={`https://basescan.org/tx/${tier.payoutTxHash}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-400/15 dark:text-emerald-300 dark:hover:bg-emerald-400/25"
            >
              <CheckIcon />
              Paid
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
              <CheckIcon />
              Paid
            </span>
          )
        ) : tier.status === "failed" ? (
          <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-1 text-[11px] font-bold text-rose-700 dark:bg-rose-400/15 dark:text-rose-300">
            Payout issue
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-400 dark:bg-white/10 dark:text-slate-500">
            <LockIcon />
            Locked
          </span>
        )}
      </span>
    </div>
  );
}

export function SweepCampaignModal({
  open,
  status,
  address,
  onClose,
  onRefresh,
}: {
  open: boolean;
  status: CampaignStatus | null;
  address?: string | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { signMessageAsync } = useSignMessage();
  const [claimingTier, setClaimingTier] = useState<number | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
    };
  }, []);

  if (!open || !status?.campaign) return null;

  const campaign = status.campaign;
  const viewer = status.viewer;
  const phase = status.phase ?? "closed";
  const capUsd = campaign.volumeCapUsd || 500;
  const cappedVolume = Math.min(viewer?.cappedVolumeUsd ?? 0, capUsd);
  const progressPercent = Math.max(0, Math.min(100, (cappedVolume / capUsd) * 100));
  const daysLeft = getCampaignDaysLeft(campaign.endsAt);
  const totalReward = campaign.tiers.reduce((sum, tier) => sum + tier.rewardUsdc, 0);
  // Default to true so a slightly older cached payload never hides the button.
  const payoutsAvailable = status.payoutsAvailable !== false;
  const hasUnlockedTier = (viewer?.tiers ?? []).some(
    (tier) => tier.status === "claimable" || tier.status === "processing"
  );

  const handleClaim = async (tier: number) => {
    if (!address || claimingTier !== null) return;
    setClaimError(null);
    setClaimingTier(tier);
    try {
      const message = buildCampaignClaimMessage(address, campaign.slug, tier);
      const signature = (await signMessageAsync({ message })) as Hex;
      await claimCampaignTier({ address, tier, message, signature });
      onRefresh();
      // The payout worker usually lands the USDC within seconds — poll the
      // status a few times so the tier flips from Sending to Paid without a reload.
      for (const delay of [6_000, 18_000, 40_000]) {
        timersRef.current.push(setTimeout(onRefresh, delay));
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message && !/user rejected/i.test(error.message)
          ? error.message
          : null;
      if (message) {
        setClaimError(message);
      }
    } finally {
      setClaimingTier(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-950/25 px-3 pb-[calc(0.75rem+var(--safe-area-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-sm sm:px-4 sm:py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sweep-campaign-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative max-h-[calc(100dvh_-_1.5rem_-_env(safe-area-inset-top)_-_var(--safe-area-bottom))] w-full max-w-[420px] overflow-y-auto overscroll-contain rounded-[24px] bg-white px-4 pb-4 pt-6 shadow-[0_26px_90px_rgba(15,23,42,0.28)] dark:bg-[#0b1220] sm:max-h-[calc(100dvh_-_3rem)] sm:max-w-[480px] sm:px-6 sm:pb-6">
        {/* Gradient top rail */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[3px] rounded-t-[24px] bg-[linear-gradient(90deg,#0052ff,#0ea5e9,#38bdf8)]"
        />

        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-[8px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10"
          aria-label="Close campaign details"
        >
          <CloseIcon />
        </button>

        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0052ff] dark:text-[#60a5fa]">
          Limited-time campaign
        </p>
        <h2
          id="sweep-campaign-title"
          className="mt-1 text-xl font-bold tracking-[-0.01em] text-slate-950 dark:text-white sm:text-2xl"
        >
          Sweep $500, earn ${totalReward} USDC
        </h2>
        <p className="mt-1.5 text-[13px] font-medium leading-snug text-slate-500 dark:text-slate-400">
          {phase === "upcoming"
            ? `Opens ${formatUtc(campaign.startsAt)}. Sweeps before this time do not count.`
            : phase === "grace"
              ? "The sweep window has closed. Unlocked rewards can still be claimed."
              : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left. Every verified sweep on Base counts.`}
        </p>

        {/* Progress hero */}
        <div className="mt-4 rounded-[16px] border border-slate-200 bg-slate-50/70 p-3.5 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-end justify-between">
            <p className="font-mono text-[26px] font-bold leading-none tabular-nums text-slate-950 dark:text-white">
              {formatCampaignUsd(cappedVolume)}
            </p>
            <p className="text-[12px] font-semibold text-slate-400 dark:text-slate-500">
              of {formatCampaignUsd(capUsd)} swept
            </p>
          </div>
          <div className="relative mt-2.5 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,#0052ff,#38bdf8)] transition-all duration-700"
              style={{ width: `${progressPercent}%` }}
            />
            {/* Tier tick marks */}
            {campaign.tiers.slice(0, -1).map((tier) => (
              <span
                key={tier.tier}
                className="absolute top-0 h-full w-[2px] bg-white/80 dark:bg-[#0b1220]/80"
                style={{ left: `${(tier.thresholdUsd / capUsd) * 100}%` }}
              />
            ))}
          </div>
          {viewer && viewer.pendingCount > 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              <Spinner />
              Verifying {viewer.pendingCount} recent sweep{viewer.pendingCount === 1 ? "" : "s"} on-chain
            </p>
          ) : null}
        </div>

        {!address ? (
          <p className="mt-3 rounded-[12px] border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] font-semibold text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400">
            Connect your wallet to track progress and claim rewards.
          </p>
        ) : null}

        {!payoutsAvailable && hasUnlockedTier ? (
          <p className="mt-3 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] font-semibold leading-snug text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-400">
            Reward claims are opening again shortly. Your unlocked tiers are saved and stay
            claimable, nothing expires.
          </p>
        ) : null}

        {claimError ? (
          <p className="mt-3 rounded-[12px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] font-semibold text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">
            {claimError}
          </p>
        ) : null}

        {/* Tier tracker */}
        <div className="mt-4 space-y-2">
          {(viewer?.tiers ?? campaign.tiers.map((tier) => ({
            ...tier,
            status: "locked" as const,
            payoutTxHash: null,
          }))).map((tier) => (
            <TierRow
              key={tier.tier}
              tier={tier}
              isClaiming={claimingTier === tier.tier}
              payoutsAvailable={payoutsAvailable}
              onClaim={(t) => void handleClaim(t)}
            />
          ))}
        </div>

        {/* Leaderboard prize teaser */}
        {campaign.prizes.length > 0 ? (
          <div className="mt-4 rounded-[14px] border border-amber-200/80 bg-amber-50/60 px-3 py-2.5 dark:border-amber-400/20 dark:bg-amber-400/[0.06]">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-700 dark:text-amber-400">
              Leaderboard bonus
            </p>
            <p className="mt-1 text-[12px] font-medium leading-snug text-slate-600 dark:text-slate-300">
              Highest total volume wins {formatCampaignUsd(campaign.prizes[0]?.prizeUsdc ?? 0)} plus{" "}
              {formatCampaignPp(campaign.prizes[0]?.prizePp ?? 0)}. Every rank in the top 50 earns
              USDC and PP, paid out once the challenge ends.{" "}
              {phase === "upcoming"
                ? "The board opens when the campaign starts."
                : "The full board is below the sweeper."}
            </p>
          </div>
        ) : null}

        {/* Rules */}
        <div className="mt-4 space-y-1 border-t border-slate-100 pt-3 dark:border-white/10">
          {[
            "Base network sweeps only. Volume is verified on-chain.",
            `Challenge runs ${formatUtc(campaign.startsAt)} to ${formatUtc(campaign.endsAt)}.`,
            "Tier rewards are sent automatically in USDC on Base.",
            "Leaderboard prizes are paid after the 2 week challenge ends.",
            `Claims stay open ${campaign.claimGraceDays} days after the campaign ends.`,
          ].map((rule) => (
            <p
              key={rule}
              className="text-[11px] font-medium leading-snug text-slate-400 dark:text-slate-500"
            >
              • {rule}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
