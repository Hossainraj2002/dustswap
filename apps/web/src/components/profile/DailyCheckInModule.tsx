"use client";

import { useEffect, useState } from "react";
import type { PointsBalance } from "@/lib/points";

type CelebrationState =
  | {
      kind: "checkin" | "save";
      id: number;
    }
  | null;

type RecoveryStage = "idle" | "wallet" | "verifying";

type DailyCheckInModuleProps = {
  balance: PointsBalance | null;
  isCheckingIn: boolean;
  isSaving: boolean;
  isResetting: boolean;
  recoveryStage: RecoveryStage;
  celebration: CelebrationState;
  walletReady: boolean;
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

function getTimerLabel(balance: PointsBalance) {
  if (balance.streakStatus === "broken") {
    return "Your save window is live";
  }

  return balance.checkedInToday ? "Time until next check-in" : "Time left to protect today";
}

function ProgressMap({ balance }: { balance: PointsBalance }) {
  const filledCount = getFilledCount(balance);
  const highlightIndex = getHighlightIndex(balance);
  const inInfiniteMode =
    (balance.streakStatus === "broken"
      ? balance.recoverableStreak
      : balance.rawStreak) >= balance.streakLength;

  return (
    <div className="relative rounded-[28px] border border-white/60 bg-white/70 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
      <div
        className={`absolute inset-x-6 top-1/2 h-px -translate-y-1/2 ${
          balance.streakStatus === "broken"
            ? "bg-[repeating-linear-gradient(90deg,rgba(244,114,68,0.9)_0_12px,rgba(255,255,255,0)_12px_20px)]"
            : inInfiniteMode
              ? "bg-[linear-gradient(90deg,rgba(255,214,102,0.15),rgba(240,171,0,0.95),rgba(255,214,102,0.15))]"
              : "bg-[linear-gradient(90deg,rgba(16,185,129,0.1),rgba(59,130,246,0.9),rgba(16,185,129,0.1))]"
        }`}
      />

      {balance.streakStatus === "broken" ? (
        <div className="pointer-events-none absolute inset-0 rounded-[28px] bg-[linear-gradient(120deg,transparent_0,transparent_40%,rgba(248,113,113,0.18)_40%,rgba(248,113,113,0.18)_43%,transparent_43%,transparent_54%,rgba(251,146,60,0.2)_54%,rgba(251,146,60,0.2)_57%,transparent_57%,transparent_100%)]" />
      ) : null}

      <div className="grid grid-cols-6 gap-2">
        {Array.from({ length: balance.streakLength }).map((_, index) => {
          const day = index + 1;
          const isFilled = index < filledCount;
          const isHighlight = index === highlightIndex;

          return (
            <div
              key={day}
              className={`relative aspect-square rounded-2xl border px-1 py-2 text-center transition-all ${
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
              } ${isHighlight ? "scale-[1.04] shadow-[0_10px_24px_rgba(56,189,248,0.22)]" : ""}`}
            >
              {isHighlight ? (
                <div
                  className={`pointer-events-none absolute inset-0 rounded-2xl ${
                    balance.streakStatus === "broken"
                      ? "animate-pulse bg-[radial-gradient(circle,rgba(251,146,60,0.28),transparent_68%)]"
                      : inInfiniteMode
                        ? "animate-pulse bg-[radial-gradient(circle,rgba(250,204,21,0.34),transparent_68%)]"
                        : "animate-pulse bg-[radial-gradient(circle,rgba(56,189,248,0.3),transparent_68%)]"
                  }`}
                />
              ) : null}
              <p className="relative text-[10px] font-semibold uppercase tracking-[0.24em]">
                Day
              </p>
              <p className="relative mt-1 text-base font-black">{day}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DailyCheckInModule({
  balance,
  isCheckingIn,
  isSaving,
  isResetting,
  recoveryStage,
  celebration,
  walletReady,
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
      <section className="rounded-[34px] border border-white/60 bg-[#fbfaf6] p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-32 rounded-full bg-slate-200" />
          <div className="h-12 w-64 rounded-2xl bg-slate-200" />
          <div className="h-24 rounded-[28px] bg-slate-100" />
          <div className="grid grid-cols-6 gap-2">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="aspect-square rounded-2xl bg-slate-100" />
            ))}
          </div>
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
  const inInfiniteMode =
    (balance.streakStatus === "broken"
      ? balance.recoverableStreak
      : balance.rawStreak) >= balance.streakLength;

  return (
    <section
      className={`relative overflow-hidden rounded-[34px] border p-5 shadow-[0_28px_90px_rgba(15,23,42,0.1)] sm:p-7 ${
        balance.streakStatus === "broken"
          ? "border-orange-300/60 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.22),transparent_34%),linear-gradient(180deg,#fff5ef,#ffe5d3)]"
          : inInfiniteMode
            ? "border-amber-300/60 bg-[radial-gradient(circle_at_top_left,rgba(250,204,21,0.22),transparent_34%),linear-gradient(180deg,#fff9e7,#fff1bf)]"
            : "border-white/70 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.2),transparent_36%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.16),transparent_32%),linear-gradient(180deg,#fffdf7,#f3fbff)]"
      }`}
    >
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute -left-10 top-0 h-48 w-48 rounded-full bg-white/40 blur-3xl" />
        <div className="absolute right-0 top-10 h-40 w-40 rounded-full bg-white/25 blur-3xl" />
      </div>

      {celebration ? (
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          {Array.from({ length: 12 }).map((_, index) => (
            <span
              key={`${celebration.id}-${index}`}
              className="absolute top-12 h-3 w-3 animate-checkin-burst rounded-full"
              style={{
                left: `${10 + index * 7}%`,
                background:
                  celebration.kind === "save"
                    ? index % 2 === 0
                      ? "#f59e0b"
                      : "#60a5fa"
                    : index % 2 === 0
                      ? "#34d399"
                      : "#fbbf24",
                animationDelay: `${index * 40}ms`,
              }}
            />
          ))}

          <div className="absolute inset-x-0 top-16 text-center">
            <div className="inline-flex animate-float-up items-center gap-3 rounded-full border border-white/80 bg-white/88 px-5 py-3 shadow-[0_18px_40px_rgba(15,23,42,0.12)]">
              <span className="text-lg">
                {celebration.kind === "save" ? "🔓" : "✨"}
              </span>
              <span className="text-sm font-black uppercase tracking-[0.24em] text-slate-800">
                {celebration.kind === "save"
                  ? "Streak Saved!"
                  : "+10% Boost Unlocked!"}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {recoveryStage === "verifying" ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[linear-gradient(180deg,rgba(255,249,240,0.92),rgba(255,236,214,0.96))] backdrop-blur-sm">
          <div className="rounded-[30px] border border-orange-200/80 bg-white/85 p-7 text-center shadow-[0_20px_60px_rgba(249,115,22,0.12)]">
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border border-orange-200/80 bg-[radial-gradient(circle,rgba(251,191,36,0.28),transparent_60%)]">
              <div className="relative h-16 w-16">
                <div className="absolute inset-0 rounded-full border border-sky-300/70 animate-radar-ring" />
                <div className="absolute inset-2 rounded-full border border-orange-300/70 animate-radar-ring [animation-delay:220ms]" />
                <div className="absolute inset-0 animate-radar-spin bg-[conic-gradient(from_0deg,transparent_0_300deg,rgba(56,189,248,0.9)_300deg_360deg)] opacity-75 [mask-image:radial-gradient(circle,transparent_0_34%,black_34%_100%)]" />
              </div>
            </div>
            <p className="mt-5 text-[11px] font-black uppercase tracking-[0.34em] text-orange-500">
              Recovery Scan
            </p>
            <h3 className="mt-3 text-2xl font-black text-slate-900">
              Verifying transaction on-chain...
            </h3>
            <p className="mt-3 max-w-sm text-sm leading-6 text-slate-600">
              DustSwap is checking your payment, matching the wallet, and thawing your streak path.
            </p>
          </div>
        </div>
      ) : null}

      <div className="relative z-10">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-[11px] font-black uppercase tracking-[0.34em] text-slate-500">
              Daily Check-In
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <h2 className="text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                {balance.streakStatus === "broken"
                  ? "Ohhh you missed your streak and boost!"
                  : inInfiniteMode
                    ? "Infinite Mode is live"
                    : `Day ${displayDay}`}
              </h2>
              {inInfiniteMode && balance.streakStatus !== "broken" ? (
                <span className="rounded-full border border-amber-300/70 bg-amber-200/60 px-3 py-1 text-[11px] font-black uppercase tracking-[0.24em] text-amber-900">
                  Max +300%
                </span>
              ) : null}
            </div>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600 sm:text-base">
              {balance.streakStatus === "broken"
                ? "Your multiplier is frozen, but you can still buy the streak back before you choose to reset."
                : balance.checkedInToday
                  ? `Today is locked in. Come back tomorrow to push toward Day ${Math.min(balance.streak + 1, balance.streakLength)}.`
                  : "Tap in once a day, bank 100 PP, and stack a multiplier that only boosts your self-earned points."}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:w-auto">
            <div className="rounded-[24px] border border-white/70 bg-white/78 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
              <p className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                Current Boost
              </p>
              <p
                className={`mt-2 text-3xl font-black tracking-tight ${
                  balance.streakStatus === "broken"
                    ? "text-orange-500 line-through decoration-2"
                    : inInfiniteMode
                      ? "text-amber-600"
                      : "text-sky-600"
                }`}
              >
                +{displayBoost}%
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Referral points are excluded
              </p>
            </div>

            <div className="rounded-[24px] border border-white/70 bg-white/78 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
              <p className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-500">
                Daily Reward
              </p>
              <p className="mt-2 text-3xl font-black tracking-tight text-emerald-600">
                {balance.checkInRewardPoints} PP
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Next target: +{nextTargetBoost}%
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <ProgressMap balance={balance} />

          <div className="flex flex-col gap-4">
            <div className="rounded-[28px] border border-white/70 bg-white/78 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
              <p className="text-[11px] font-black uppercase tracking-[0.28em] text-slate-500">
                {getTimerLabel(balance)}
              </p>
              <p className="mt-3 text-3xl font-black tracking-tight text-slate-950">
                {timerLabel}
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                {balance.streakStatus === "broken"
                  ? "Save now to restore the multiplier. If you pass, the next check-in starts back at zero."
                  : balance.checkedInToday
                    ? `Your next claim window opens after ${new Date(balance.nextCheckInAt).toUTCString()}.`
                    : `Keep the chain alive before ${new Date(balance.dayEndsAt).toUTCString()}.`}
              </p>
            </div>

            {balance.streakStatus === "broken" ? (
              <div className="rounded-[28px] border border-orange-200/80 bg-white/78 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-black uppercase tracking-[0.28em] text-orange-500">
                      Recovery Mode
                    </p>
                    <h3 className="mt-3 text-2xl font-black text-slate-950">
                      Continue from Day {balance.recoverableStreak}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      The save sends funds to{" "}
                      <span className="font-semibold text-slate-800">
                        {formatCompactAddress(balance.saveConfig.recipient)}
                      </span>{" "}
                      and restores your streak at its current level.
                    </p>
                  </div>

                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-orange-200 bg-[radial-gradient(circle,rgba(251,146,60,0.25),transparent_70%)] text-2xl">
                    ⛓
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onSave}
                  disabled={!walletReady || isSaving || recoveryStage !== "idle"}
                  className="group relative mt-5 flex w-full items-center justify-center overflow-hidden rounded-[24px] border border-transparent bg-[linear-gradient(135deg,#2563eb_0%,#7c3aed_55%,#f59e0b_100%)] px-5 py-4 text-base font-black text-white shadow-[0_18px_42px_rgba(37,99,235,0.28)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_22px_54px_rgba(124,58,237,0.24)] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <span className="absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.22),transparent)] opacity-0 transition duration-300 group-hover:opacity-100" />
                  <span className="relative">
                    {recoveryStage === "wallet"
                      ? "Confirm in Wallet..."
                      : isSaving
                        ? "Saving Streak..."
                        : "Pay $1 (ETH/USDC) & Continue from Here"}
                  </span>
                </button>

                <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
                  <span>
                    Using {preferredSaveAsset === "usdc" ? "1 USDC" : `~${balance.saveConfig.ethAmountDisplay} ETH`}
                  </span>
                  <div className="group relative inline-flex items-center gap-1">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[10px] font-black text-slate-600">
                      i
                    </span>
                    <span>Gas fees</span>
                    <div className="pointer-events-none absolute bottom-full right-0 mb-2 w-48 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-left text-[11px] leading-5 text-slate-600 opacity-0 shadow-[0_18px_40px_rgba(15,23,42,0.1)] transition group-hover:opacity-100">
                      Standard network gas fees apply.
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onReset}
                  disabled={isResetting || isSaving}
                  className="mt-4 w-full rounded-[20px] border border-slate-300/70 bg-white/40 px-4 py-3 text-sm font-semibold text-slate-500 transition hover:bg-white/70 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isResetting ? "Resetting..." : "Reset Streak to 0"}
                </button>
              </div>
            ) : (
              <div className="rounded-[28px] border border-white/70 bg-white/78 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                <p className="text-[11px] font-black uppercase tracking-[0.28em] text-slate-500">
                  Claim Station
                </p>
                <h3 className="mt-3 text-2xl font-black text-slate-950">
                  {balance.checkedInToday
                    ? "Daily boost is already locked"
                    : balance.streak === 0
                      ? "Start your streak today"
                      : `Ready to unlock +${Math.min(balance.nextBoostPercent, balance.boostCapPercent)}%`}
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {balance.checkedInToday
                    ? `Your streak is protected and sitting at +${balance.boostPercent}%.`
                    : "One tap adds 100 PP and raises your self-earned multiplier by another 10%."}
                </p>

                <button
                  type="button"
                  onClick={onCheckIn}
                  disabled={balance.checkedInToday || isCheckingIn || !walletReady}
                  className="group relative mt-5 flex w-full items-center justify-center overflow-hidden rounded-[28px] border border-transparent bg-[linear-gradient(135deg,#0ea5e9_0%,#22c55e_100%)] px-5 py-5 text-lg font-black tracking-[0.08em] text-white shadow-[0_18px_50px_rgba(14,165,233,0.24)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_64px_rgba(34,197,94,0.24)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.22),transparent)] opacity-0 transition duration-300 group-hover:opacity-100" />
                  <span className="relative">
                    {isCheckingIn
                      ? "Checking In..."
                      : balance.checkedInToday
                        ? "Checked In Today"
                        : "Check In Now"}
                  </span>
                </button>

                <div className="mt-4 rounded-2xl border border-slate-200/70 bg-[#fbf7ec] px-4 py-3 text-sm text-slate-600">
                  <span className="font-semibold text-slate-800">Boost scope:</span>{" "}
                  {balance.boostAppliesTo}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
