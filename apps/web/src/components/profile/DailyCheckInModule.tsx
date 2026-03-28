"use client";

import { useEffect, useState } from "react";
import type { PointsBalance } from "@/lib/points";

type CelebrationState =
  | {
      kind: "checkin" | "save";
      id: number;
    }
  | null;

type FlowStage = "idle" | "wallet" | "verifying";

type DailyCheckInModuleProps = {
  balance: PointsBalance | null;
  isCheckingIn: boolean;
  isSaving: boolean;
  isResetting: boolean;
  checkInStage: FlowStage;
  recoveryStage: FlowStage;
  celebration: CelebrationState;
  walletReady: boolean;
  preferredCheckInAsset: "eth" | "usdc";
  preferredSaveAsset: "eth" | "usdc";
  onCheckIn: () => void;
  onSave: () => void;
  onReset: () => void;
};

function formatTimer(target: string | null, now: number) {
  if (!target) {
    return "--h --m --s";
  }

  const diff = new Date(target).getTime() - now;
  if (diff <= 0) {
    return "00h 00m 00s";
  }

  const totalSeconds = Math.floor(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function formatCompactAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getDisplayDay(balance: PointsBalance) {
  if (balance.streakStatus === "broken") {
    return balance.recoverableStreak;
  }

  if (balance.checkedInToday) {
    return Math.max(balance.streak, 1);
  }

  return Math.max(balance.streak + 1, 1);
}

function getFilledCount(balance: PointsBalance) {
  if (balance.streakStatus === "broken") {
    return Math.min(balance.recoverableStreak, balance.streakLength);
  }

  return Math.min(balance.streak, balance.streakLength);
}

function getHighlightIndex(balance: PointsBalance) {
  if (balance.streakStatus === "broken") {
    return Math.max(Math.min(balance.recoverableStreak, balance.streakLength) - 1, 0);
  }

  if (balance.checkedInToday) {
    return Math.max(Math.min(balance.streak, balance.streakLength) - 1, 0);
  }

  return Math.min(balance.streak, balance.streakLength - 1);
}

function CompactProgress({ balance }: { balance: PointsBalance }) {
  const filledCount = getFilledCount(balance);
  const highlightIndex = getHighlightIndex(balance);
  const inInfiniteMode =
    (balance.streakStatus === "broken"
      ? balance.recoverableStreak
      : balance.rawStreak) >= balance.streakLength;

  return (
    <div className="rounded-[22px] border border-white/70 bg-white/78 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">
          30 Day Track
        </p>
        <p className="text-xs font-semibold text-slate-500">
          {balance.streakStatus === "broken"
            ? `Frozen at Day ${balance.recoverableStreak}`
            : inInfiniteMode
              ? "Infinite mode"
              : `${filledCount}/${balance.streakLength}`}
        </p>
      </div>

      <div className="grid grid-cols-10 gap-1.5 sm:hidden">
        {Array.from({ length: balance.streakLength }).map((_, index) => {
          const isFilled = index < filledCount;
          const isHighlight = index === highlightIndex;

          return (
            <span
              key={index}
              className={`relative h-2.5 rounded-full ${
                balance.streakStatus === "broken"
                  ? isFilled
                    ? "bg-orange-300"
                    : "bg-orange-100"
                  : inInfiniteMode
                    ? isFilled
                      ? "bg-amber-400"
                      : "bg-amber-100"
                    : isFilled
                      ? "bg-sky-400"
                      : "bg-sky-100"
              } ${isHighlight ? "ring-2 ring-white shadow-[0_0_0_2px_rgba(56,189,248,0.28)]" : ""}`}
            />
          );
        })}
      </div>

      <div className="hidden grid-cols-6 gap-2 sm:grid">
        {Array.from({ length: balance.streakLength }).map((_, index) => {
          const day = index + 1;
          const isFilled = index < filledCount;
          const isHighlight = index === highlightIndex;

          return (
            <div
              key={day}
              className={`relative rounded-2xl border px-2 py-2 text-center ${
                balance.streakStatus === "broken"
                  ? isFilled
                    ? "border-orange-300/60 bg-[linear-gradient(180deg,#fff2e2,#ffd8b8)] text-orange-800"
                    : "border-orange-200/50 bg-white/60 text-orange-300"
                  : inInfiniteMode
                    ? isFilled
                      ? "border-amber-300/70 bg-[linear-gradient(180deg,#fff3c4,#ffd54f)] text-amber-900"
                      : "border-amber-100/80 bg-[#fff8df] text-amber-300"
                    : isFilled
                      ? "border-sky-300/70 bg-[linear-gradient(180deg,#dff6ff,#b8e6ff)] text-sky-900"
                      : "border-[#d8e9f5] bg-[#f6fbff] text-[#9fb2c6]"
              } ${isHighlight ? "shadow-[0_8px_18px_rgba(56,189,248,0.18)]" : ""}`}
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em]">Day</p>
              <p className="mt-1 text-sm font-black">{day}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniInfo({
  label,
  value,
  subtext,
  tone,
}: {
  label: string;
  value: string;
  subtext: string;
  tone: "sky" | "emerald" | "orange";
}) {
  const tones = {
    sky: "text-sky-600",
    emerald: "text-emerald-600",
    orange: "text-orange-500",
  };

  return (
    <div className="rounded-[20px] border border-white/70 bg-white/78 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-black tracking-tight ${tones[tone]}`}>{value}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{subtext}</p>
    </div>
  );
}

export function DailyCheckInModule({
  balance,
  isCheckingIn,
  isSaving,
  isResetting,
  checkInStage,
  recoveryStage,
  celebration,
  walletReady,
  preferredCheckInAsset,
  preferredSaveAsset,
  onCheckIn,
  onSave,
  onReset,
}: DailyCheckInModuleProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  if (!balance) {
    return (
      <section className="rounded-[28px] border border-white/60 bg-[#fbfaf6] p-4 shadow-[0_20px_70px_rgba(15,23,42,0.08)]">
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-28 rounded-full bg-slate-200" />
          <div className="h-10 w-40 rounded-2xl bg-slate-200" />
          <div className="h-16 rounded-[20px] bg-slate-100" />
          <div className="h-24 rounded-[20px] bg-slate-100" />
        </div>
      </section>
    );
  }

  const displayDay = getDisplayDay(balance);
  const displayBoost =
    balance.streakStatus === "broken"
      ? balance.recoverableBoostPercent
      : balance.boostPercent;
  const nextTargetBoost =
    balance.streakStatus === "broken"
      ? balance.recoverableBoostPercent
      : balance.nextBoostPercent;
  const timerTarget =
    balance.streakStatus === "broken"
      ? balance.dayEndsAt
      : balance.checkedInToday
        ? balance.nextCheckInAt
        : balance.dayEndsAt;
  const timerLabel = formatTimer(timerTarget, now);
  const isVerifying = checkInStage === "verifying" || recoveryStage === "verifying";
  const verifyingCopy =
    recoveryStage === "verifying"
      ? "Verifying streak save on-chain..."
      : "Verifying daily check-in on-chain...";

  const checkInPaymentLabel =
    preferredCheckInAsset === "usdc"
      ? `${balance.checkInConfig.usdcAmount} USDC`
      : `$${balance.checkInConfig.usdTarget.toFixed(2)} in ETH`;
  const savePaymentLabel =
    preferredSaveAsset === "usdc"
      ? `${balance.saveConfig.usdcAmount} USDC`
      : `$${balance.saveConfig.usdTarget.toFixed(2)} in ETH`;

  return (
    <section
      className={`relative overflow-hidden rounded-[28px] border p-4 shadow-[0_20px_70px_rgba(15,23,42,0.1)] sm:p-6 ${
        balance.streakStatus === "broken"
          ? "border-orange-300/60 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.2),transparent_32%),linear-gradient(180deg,#fff5ef,#ffe5d3)]"
          : "border-white/70 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.18),transparent_34%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.14),transparent_30%),linear-gradient(180deg,#fffdf7,#f3fbff)]"
      }`}
    >
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute -left-10 top-0 h-32 w-32 rounded-full bg-white/40 blur-3xl" />
        <div className="absolute right-0 top-8 h-28 w-28 rounded-full bg-white/25 blur-3xl" />
      </div>

      {celebration ? (
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          {Array.from({ length: 10 }).map((_, index) => (
            <span
              key={`${celebration.id}-${index}`}
              className="absolute top-10 h-2.5 w-2.5 animate-checkin-burst rounded-full"
              style={{
                left: `${10 + index * 8}%`,
                background:
                  celebration.kind === "save"
                    ? index % 2 === 0
                      ? "#f59e0b"
                      : "#60a5fa"
                    : index % 2 === 0
                      ? "#34d399"
                      : "#fbbf24",
                animationDelay: `${index * 35}ms`,
              }}
            />
          ))}

          <div className="absolute inset-x-0 top-10 text-center">
            <div className="inline-flex animate-float-up items-center gap-2 rounded-full border border-white/80 bg-white/88 px-4 py-2 shadow-[0_16px_34px_rgba(15,23,42,0.12)]">
              <span className="text-base">{celebration.kind === "save" ? "🔓" : "✨"}</span>
              <span className="text-xs font-black uppercase tracking-[0.24em] text-slate-800">
                {celebration.kind === "save" ? "Streak Saved!" : "+10% Boost"}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {isVerifying ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[linear-gradient(180deg,rgba(255,249,240,0.92),rgba(255,236,214,0.96))] backdrop-blur-sm">
          <div className="rounded-[24px] border border-orange-200/80 bg-white/90 p-6 text-center shadow-[0_18px_50px_rgba(249,115,22,0.12)]">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-orange-200/80 bg-[radial-gradient(circle,rgba(251,191,36,0.28),transparent_60%)]">
              <div className="relative h-12 w-12">
                <div className="absolute inset-0 rounded-full border border-sky-300/70 animate-radar-ring" />
                <div className="absolute inset-1.5 rounded-full border border-orange-300/70 animate-radar-ring [animation-delay:220ms]" />
                <div className="absolute inset-0 animate-radar-spin bg-[conic-gradient(from_0deg,transparent_0_300deg,rgba(56,189,248,0.9)_300deg_360deg)] opacity-75 [mask-image:radial-gradient(circle,transparent_0_34%,black_34%_100%)]" />
              </div>
            </div>
            <p className="mt-4 text-[10px] font-black uppercase tracking-[0.32em] text-orange-500">
              Onchain Verify
            </p>
            <p className="mt-2 text-lg font-black text-slate-900">{verifyingCopy}</p>
          </div>
        </div>
      ) : null}

      <div className="relative z-10">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.32em] text-slate-500">
              Daily Check-In
            </p>
            <h2 className="mt-2 text-[2rem] font-black tracking-tight text-slate-950">
              {balance.streakStatus === "broken"
                ? "Missed the streak"
                : `Day ${displayDay}`}
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-slate-600">
              {balance.streakStatus === "broken"
                ? "Pay to continue from here or reset to zero."
                : balance.checkedInToday
                  ? "Locked for today. Come back tomorrow."
                  : "Phone-first onchain tap. USDC first, ETH fallback."}
            </p>
          </div>

          <div className="rounded-full border border-white/70 bg-white/78 px-3 py-2 text-right shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
              Timer
            </p>
            <p className="mt-1 text-sm font-black text-slate-900">{timerLabel}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <MiniInfo
            label="Current Boost"
            value={`+${displayBoost}%`}
            subtext="Referral points excluded"
            tone={balance.streakStatus === "broken" ? "orange" : "sky"}
          />
          <MiniInfo
            label="Daily Reward"
            value={`${balance.checkInRewardPoints} PP`}
            subtext={`Next target: +${nextTargetBoost}%`}
            tone="emerald"
          />
        </div>

        <div className="mt-3">
          <CompactProgress balance={balance} />
        </div>

        {balance.streakStatus === "broken" ? (
          <div className="mt-3 rounded-[22px] border border-orange-200/80 bg-white/78 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-orange-500">
                  Restore Flow
                </p>
                <h3 className="mt-2 text-xl font-black text-slate-950">
                  Continue from Day {balance.recoverableStreak}
                </h3>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  Receiver: {formatCompactAddress(balance.saveConfig.recipient)}
                </p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-orange-200 bg-[radial-gradient(circle,rgba(251,146,60,0.25),transparent_70%)] text-xl">
                ⛓
              </div>
            </div>

            <button
              type="button"
              onClick={onSave}
              disabled={!walletReady || isSaving || recoveryStage !== "idle"}
              className="group relative mt-4 flex w-full items-center justify-center overflow-hidden rounded-[22px] border border-transparent bg-[linear-gradient(135deg,#2563eb_0%,#7c3aed_55%,#f59e0b_100%)] px-4 py-4 text-sm font-black text-white shadow-[0_16px_38px_rgba(37,99,235,0.24)] transition duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.22),transparent)] opacity-0 transition duration-300 group-hover:opacity-100" />
              <span className="relative">
                {recoveryStage === "wallet"
                  ? "Confirm Save in Wallet..."
                  : isSaving
                    ? "Saving Streak..."
                    : "Pay $1 (ETH/USDC) & Continue from Here"}
              </span>
            </button>

            <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-500">
              <span>Using {savePaymentLabel}</span>
              <span>Gas fees apply</span>
            </div>

            <button
              type="button"
              onClick={onReset}
              disabled={isResetting || isSaving}
              className="mt-3 w-full rounded-[18px] border border-slate-300/70 bg-white/50 px-4 py-3 text-sm font-semibold text-slate-500 transition hover:bg-white/70 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isResetting ? "Resetting..." : "Reset Streak to 0"}
            </button>
          </div>
        ) : (
          <div className="mt-3 rounded-[22px] border border-white/70 bg-white/78 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">
                  Check-In Fee
                </p>
                <h3 className="mt-2 text-xl font-black text-slate-950">
                  {balance.checkedInToday ? "Already checked today" : "Onchain check-in"}
                </h3>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  Uses {checkInPaymentLabel}. ETH price is locked for {balance.checkInConfig.priceDate}.
                </p>
              </div>
              <div className="rounded-full border border-slate-200 bg-[#fbf7ec] px-3 py-2 text-right">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">
                  Scope
                </p>
                <p className="mt-1 text-xs font-semibold text-slate-700">Self-earned only</p>
              </div>
            </div>

            <button
              type="button"
              onClick={onCheckIn}
              disabled={balance.checkedInToday || isCheckingIn || !walletReady}
              className="group relative mt-4 flex w-full items-center justify-center overflow-hidden rounded-[24px] border border-transparent bg-[linear-gradient(135deg,#0ea5e9_0%,#22c55e_100%)] px-4 py-4 text-base font-black text-white shadow-[0_16px_42px_rgba(14,165,233,0.22)] transition duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.22),transparent)] opacity-0 transition duration-300 group-hover:opacity-100" />
              <span className="relative">
                {checkInStage === "wallet"
                  ? "Confirm Check-In in Wallet..."
                  : isCheckingIn
                    ? "Checking In..."
                    : balance.checkedInToday
                      ? "Checked In Today"
                      : "Check In Onchain"}
              </span>
            </button>

            <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-500">
              <span>Fallback: ETH if no USDC on Base</span>
              <span>Gas fees apply</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
