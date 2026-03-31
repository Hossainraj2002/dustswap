"use client";

import Link from "next/link";
import { startTransition, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import {
  fetchQuestBoard,
  saveXUsername,
  syncSwapQuestActivity,
  startQuest,
  verifyDelayQuest,
  verifyXPost,
} from "@/lib/quests";
import { PremiumQuestBackground } from "@/components/quests/PremiumQuestBackground";
import type { QuestItem } from "@/types/quests";

type CategoryFilter = "social" | "onchain";
type PendingState = Record<string, boolean>;
type PostInputState = Record<string, string>;

const SYNC_NOW_EVENT = "dustswap:quest-sync-now";
const SWAP_RECORDED_EVENT = "dustswap:quest-swap-recorded";

const ONCHAIN_WINDOWS = [
  { key: "once", label: "Once" },
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
] as const;

function getDisplayError(error: unknown) {
  const message = (error as Error)?.message || "Request failed";
  if (message === "Failed to fetch") {
    return "Could not reach the quest API. Check NEXT_PUBLIC_API_URL and make sure it uses the Railway root URL without /api.";
  }

  return message;
}

function formatPoints(points: number) {
  return `${points.toLocaleString()} PP`;
}

function formatXUsernameDisplay(value?: string | null) {
  if (!value) {
    return "";
  }

  return value.startsWith("@") ? value : `@${value}`;
}

function formatWindowLabel(windowType: QuestItem["progressWindow"]) {
  if (windowType === "daily") {
    return "Daily";
  }

  if (windowType === "weekly") {
    return "Weekly";
  }

  return "Once";
}

function getCountdownLabel(nextVerificationAt?: string | null) {
  if (!nextVerificationAt) {
    return null;
  }

  const diff = new Date(nextVerificationAt).getTime() - Date.now();
  if (diff <= 0) {
    return "Verify";
  }

  return `Verify in ${Math.ceil(diff / 1000)}s`;
}

function getProgressPercent(progressValue: number, targetValue: number) {
  if (!targetValue) {
    return 0;
  }

  return Math.min(100, Math.round((progressValue / targetValue) * 100));
}

function normalizeQuestUrl(quest: QuestItem) {
  if (quest.ctaUrl) {
    return quest.ctaUrl;
  }

  if (typeof quest.rules.externalUrl === "string") {
    return quest.rules.externalUrl;
  }

  return null;
}

function getNextResetTime(windowType: QuestItem["progressWindow"], now = new Date()) {
  if (windowType === "daily") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    );
  }

  if (windowType === "weekly") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const day = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - (day - 1));
    start.setUTCHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return end;
  }

  return null;
}

function formatResetCountdown(windowType: QuestItem["progressWindow"]) {
  const resetAt = getNextResetTime(windowType);
  if (!resetAt) {
    return "Open";
  }

  const diff = resetAt.getTime() - Date.now();
  if (diff <= 0) {
    return "Resetting";
  }

  const totalMinutes = Math.ceil(diff / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `Reset in ${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `Reset in ${hours}h ${minutes}m`;
  }

  return `Reset in ${minutes}m`;
}

function formatGoalValue(quest: QuestItem) {
  if (quest.actionType === "swap_volume") {
    return `$${quest.targetValue.toLocaleString()}`;
  }

  if (quest.actionType === "swap_count") {
    return `${quest.targetValue.toLocaleString()} swaps`;
  }

  return "1 action";
}

function formatProgressValue(quest: QuestItem, value: number) {
  if (quest.actionType === "swap_count") {
    return value.toLocaleString();
  }

  return `$${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

function StatusPill({ quest }: { quest: QuestItem }) {
  if (quest.progress?.completedAt) {
    return (
      <span className="rounded-full border border-emerald-200/90 bg-emerald-50/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
        Completed
      </span>
    );
  }

  if (quest.progress?.status === "retry_required") {
    return (
      <span className="rounded-full border border-amber-200/90 bg-amber-50/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-700">
        Retry
      </span>
    );
  }

  if (quest.progressWindow === "daily" || quest.progressWindow === "weekly") {
    return (
      <span className="rounded-full border border-sky-200/90 bg-sky-50/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-700">
        {formatResetCountdown(quest.progressWindow)}
      </span>
    );
  }

  return (
    <span className="rounded-full border border-slate-200/90 bg-white/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
      Open
    </span>
  );
}

function WindowPill({ quest }: { quest: QuestItem }) {
  return (
    <span className="rounded-full border border-slate-200/90 bg-white/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
      {formatWindowLabel(quest.progressWindow)}
    </span>
  );
}

function CompletedStamp() {
  return (
    <div className="pointer-events-none absolute inset-x-[-8%] top-6 rotate-[-10deg] border-y border-emerald-200 bg-emerald-50/95 py-1 text-center text-[9px] font-black tracking-[0.46em] text-emerald-700">
      COMPLETED
    </div>
  );
}

function InfoChip({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white/85 px-3 py-2 shadow-[0_10px_30px_rgba(148,163,184,0.08)]">
      <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function SectionBadge({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="rounded-full border border-sky-200/90 bg-white/85 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sky-700 shadow-[0_10px_24px_rgba(59,130,246,0.08)]">
        {label}
      </span>
      <span className="text-[11px] font-medium text-slate-500">
        {count} quest{count === 1 ? "" : "s"}
      </span>
    </div>
  );
}

export function QuestBoard() {
  const { address, isConnected } = useAccount();
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("onchain");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [board, setBoard] = useState<Awaited<ReturnType<typeof fetchQuestBoard>> | null>(null);
  const [pending, setPending] = useState<PendingState>({});
  const [postInputs, setPostInputs] = useState<PostInputState>({});
  const [xUsernameInput, setXUsernameInput] = useState("");
  const [isSavingXUsername, setIsSavingXUsername] = useState(false);

  async function loadBoard(options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;

    if (silent) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    setError(null);

    try {
      const data = await fetchQuestBoard(address);
      if (!data.success) {
        throw new Error(data.error || "Failed to load quests");
      }

      setBoard(data);
    } catch (loadError) {
      setError(getDisplayError(loadError));
    } finally {
      if (silent) {
        setIsRefreshing(false);
      } else {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    void loadBoard();
  }, [address]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setBoard((current) => (current ? { ...current } : current));
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (address && categoryFilter === "onchain") {
        void syncSwapQuestActivity(address)
          .catch(() => null)
          .finally(() => {
            void loadBoard({ silent: true });
          });
        return;
      }

      void loadBoard({ silent: true });
    }, 30000);

    return () => window.clearInterval(interval);
  }, [address, categoryFilter]);

  useEffect(() => {
    const handleSwapRecorded = () => {
      startTransition(() => {
        void loadBoard({ silent: true });
      });
    };

    window.addEventListener(SWAP_RECORDED_EVENT, handleSwapRecorded);
    return () => window.removeEventListener(SWAP_RECORDED_EVENT, handleSwapRecorded);
  }, []);

  const linkedXAccount = board?.linkedAccounts?.x;
  const isXLinked = Boolean(linkedXAccount?.username);
  const savedXUsername = formatXUsernameDisplay(linkedXAccount?.username);

  useEffect(() => {
    setXUsernameInput(savedXUsername);
  }, [savedXUsername]);

  const filteredQuests = useMemo(() => {
    const quests = board?.quests || [];

    return quests.filter((quest) => {
      if (quest.category !== categoryFilter) {
        return false;
      }

      if (quest.progressWindow === "once" && quest.progress?.completedAt) {
        return false;
      }

      return true;
    });
  }, [board?.quests, categoryFilter]);

  const onchainSections = useMemo(() => {
    return ONCHAIN_WINDOWS.map((section) => ({
      ...section,
      quests: filteredQuests.filter(
        (quest) =>
          quest.category === "onchain" && quest.progressWindow === section.key
      ),
    })).filter((section) => section.quests.length > 0);
  }, [filteredQuests]);

  const completedCount = (board?.quests || []).filter(
    (quest) => quest.progress?.completedAt
  ).length;

  async function refreshWithMessage(nextMessage?: string) {
    if (nextMessage) {
      setMessage(nextMessage);
    }

    startTransition(() => {
      void loadBoard({ silent: true });
    });
  }

  async function handleOnchainRefresh() {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    setIsRefreshing(true);
    setMessage("Checking your latest swap progress...");
    window.dispatchEvent(new Event(SYNC_NOW_EVENT));
    let syncIssue: string | null = null;

    try {
      const response = await syncSwapQuestActivity(address);
      if (!response.success) {
        throw new Error(response.error || "Failed to sync recent swaps");
      }
    } catch (syncError) {
      syncIssue = getDisplayError(syncError);
    } finally {
      await loadBoard({ silent: true });
      if (syncIssue) {
        setError(syncIssue);
      }
      setIsRefreshing(false);
    }
  }

  function isXExternalUrl(url: string) {
    try {
      const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
      const host = parsed.hostname.toLowerCase();
      return host === "x.com" || host === "www.x.com" || host === "twitter.com" || host === "www.twitter.com";
    } catch {
      return false;
    }
  }

  function openExternal(url: string) {
    if (typeof window === "undefined") {
      return;
    }

    if (isXExternalUrl(url)) {
      window.open(url);
      return;
    }

    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.assign(url);
    }
  }

  function focusXUsernameInput() {
    if (typeof document === "undefined") {
      return;
    }

    const input = document.getElementById("quest-x-username") as HTMLInputElement | null;
    input?.focus();
    input?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function handleSaveXUsername() {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    setError(null);
    setMessage(null);
    setIsSavingXUsername(true);

    try {
      const response = await saveXUsername(address, xUsernameInput);
      if (!response.success || !response.username) {
        throw new Error(response.error || "Failed to save X username");
      }

      setXUsernameInput(response.username);
      await refreshWithMessage(`X username saved as ${response.username}.`);
    } catch (saveError) {
      setError(getDisplayError(saveError));
    } finally {
      setIsSavingXUsername(false);
    }
  }

  async function handleDelayQuestStart(quest: QuestItem) {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    if (quest.platform === "x" && !isXLinked) {
      setError("Add your X username first before starting X quests.");
      focusXUsernameInput();
      return;
    }

    const questUrl = normalizeQuestUrl(quest);
    if (!questUrl) {
      setError("This quest is missing a destination URL");
      return;
    }

    setPending((current) => ({ ...current, [quest.id]: true }));
    openExternal(questUrl);

    try {
      const response = await startQuest(quest.id, address);
      if (!response.success) {
        throw new Error(response.error || "Failed to start quest");
      }

      await refreshWithMessage("Quest opened. Come back when verify unlocks.");
    } catch (startError) {
      setError(getDisplayError(startError));
    } finally {
      setPending((current) => ({ ...current, [quest.id]: false }));
    }
  }

  async function handleDelayVerify(quest: QuestItem) {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    if (quest.platform === "x" && !isXLinked) {
      setError("Add your X username first before verifying X quests.");
      focusXUsernameInput();
      return;
    }

    setPending((current) => ({ ...current, [quest.id]: true }));

    try {
      const response = await verifyDelayQuest(quest.id, address);
      if (!response.success && response.status === "cooldown") {
        setMessage(`Give it ${response.remainingSeconds || 1}s more before verifying.`);
        return;
      }

      if (!response.success && response.status === "retry_required") {
        setMessage(response.message || "Revisit the task once more, then verify again.");
      } else if (!response.success) {
        throw new Error(response.error || "Verification failed");
      } else {
        setMessage(`Quest completed. You earned ${formatPoints(response.awardedPoints || 0)}.`);
      }

      await loadBoard({ silent: true });
    } catch (verifyError) {
      setError(getDisplayError(verifyError));
    } finally {
      setPending((current) => ({ ...current, [quest.id]: false }));
    }
  }

  async function handleVerifyPost(quest: QuestItem) {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    if (!isXLinked) {
      setError("Add your X username first before verifying X quests.");
      focusXUsernameInput();
      return;
    }

    const postUrl = postInputs[quest.id]?.trim();
    if (!postUrl) {
      setError("Paste your X post link first");
      return;
    }

    setPending((current) => ({ ...current, [quest.id]: true }));

    try {
      const response = await verifyXPost(quest.id, address, postUrl);
      if (!response.success) {
        throw new Error(response.error || "Post verification failed");
      }

      setPostInputs((current) => ({ ...current, [quest.id]: "" }));
      await refreshWithMessage(
        `Post verified. You earned ${formatPoints(response.awardedPoints || 0)}.`
      );
    } catch (verifyError) {
      setError(getDisplayError(verifyError));
    } finally {
      setPending((current) => ({ ...current, [quest.id]: false }));
    }
  }

  function renderQuestCard(quest: QuestItem) {
    const questUrl = normalizeQuestUrl(quest);
    const countdownLabel = getCountdownLabel(quest.progress?.nextVerificationAt);
    const progressValue = Number(quest.progress?.value || 0);
    const percent = getProgressPercent(progressValue, quest.targetValue);
    const isDone = Boolean(quest.progress?.completedAt);
    const isPending = Boolean(pending[quest.id]);
    const canVerifyDelay =
      quest.progress?.nextVerificationAt &&
      new Date(quest.progress.nextVerificationAt).getTime() <= Date.now();
    const isXQuest = quest.platform === "x";
    const xLocked = isXQuest && !isXLinked;
    const primaryLabel = xLocked
      ? "Add X Username First"
      : quest.ctaLabel || (quest.category === "onchain" ? "Open Swap" : "Open Task");

    return (
      <article
        key={quest.id}
        className="relative flex flex-col gap-3 overflow-hidden rounded-[24px] border border-white/80 bg-white/72 p-3.5 shadow-[0_18px_48px_rgba(15,23,42,0.08)] backdrop-blur-xl"
      >
        {isDone ? <CompletedStamp /> : null}

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
              {quest.category} / {quest.platform}
            </p>
            <h2 className="mt-1.5 text-[17px] font-semibold tracking-[-0.02em] text-slate-950">
              {quest.title}
            </h2>
          </div>

          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <WindowPill quest={quest} />
            <StatusPill quest={quest} />
          </div>
        </div>

        {quest.description ? (
          <p className="text-[13px] leading-5 text-slate-600">{quest.description}</p>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <InfoChip label="Reward" value={formatPoints(quest.rewardPoints)} />
          <InfoChip label="Goal" value={formatGoalValue(quest)} />
        </div>

        {quest.actionType === "swap_volume" || quest.actionType === "swap_count" ? (
          <div className="rounded-[20px] border border-slate-200/80 bg-white/88 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-slate-500">
                {quest.actionType === "swap_count" ? "Current swaps" : "Current volume"}
              </span>
              <span className="font-semibold text-slate-900">
                {formatProgressValue(quest, progressValue)}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#1d4ed8,#38bdf8)]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Volume tracking can take up to 10 minutes.
            </p>
            <div className="mt-3 flex gap-2">
              <Link
                href={questUrl || "/swap"}
                className="inline-flex flex-1 items-center justify-center rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700"
              >
                {isDone ? "View Swap" : primaryLabel}
              </Link>
              <button
                type="button"
                onClick={() => void handleOnchainRefresh()}
                disabled={isRefreshing}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isRefreshing ? "Checking" : "Verify"}
              </button>
            </div>
          </div>
        ) : quest.verificationType === "x_post_link" ? (
          <div className="rounded-[20px] border border-slate-200/80 bg-white/88 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
            <div className="space-y-2.5">
              {quest.rules.composeText ? (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-600">
                  {quest.rules.composeText}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  if (xLocked) {
                    setError("Add your X username first before opening X quests.");
                    focusXUsernameInput();
                    return;
                  }

                  if (questUrl) {
                    openExternal(questUrl);
                  }
                }}
                disabled={!questUrl}
                className="w-full rounded-2xl border border-sky-200 bg-white px-4 py-2.5 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {xLocked ? "Add X Username First" : quest.ctaLabel || "Open Composer"}
              </button>
              <input
                value={postInputs[quest.id] || ""}
                onChange={(event) =>
                  setPostInputs((current) => ({
                    ...current,
                    [quest.id]: event.target.value,
                  }))
                }
                placeholder="Paste your X post link"
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-sky-300"
              />
              <button
                type="button"
                onClick={() => void handleVerifyPost(quest)}
                disabled={xLocked || isPending || isDone}
                className="w-full rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {xLocked
                  ? "Add X Username First"
                  : isDone
                    ? "Verified"
                    : isPending
                      ? "Verifying..."
                      : "Verify Post"}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-[20px] border border-slate-200/80 bg-white/88 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => void handleDelayQuestStart(quest)}
                disabled={(!questUrl && !xLocked) || isPending || isDone}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDone ? "Task Completed" : isPending ? "Opening..." : primaryLabel}
              </button>
              <button
                type="button"
                onClick={() => void handleDelayVerify(quest)}
                disabled={xLocked || !canVerifyDelay || isPending || isDone}
                className="w-full rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {xLocked
                  ? "Add X Username First"
                  : isDone
                    ? "Verified"
                    : isPending
                      ? "Checking..."
                      : countdownLabel || "Verify"}
              </button>
              {quest.progress?.status === "retry_required" ? (
                <p className="text-[11px] text-amber-700">
                  One more revisit is needed before this quest clears.
                </p>
              ) : null}
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="relative isolate min-h-[calc(100vh-74px)] overflow-hidden">
      <PremiumQuestBackground />

      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 py-3 sm:px-5 sm:py-5">
        <section className="rounded-[30px] border border-white/80 bg-white/68 shadow-[0_24px_80px_rgba(59,130,246,0.08)] backdrop-blur-xl">
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-2xl">
                <p className="text-[10px] font-semibold uppercase tracking-[0.34em] text-sky-700/70">
                  Quest Board
                </p>
                <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-slate-950 sm:text-[34px]">
                  Social and onchain quests.
                </h1>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
                  Start completing quests and earn Particle Points PP from every action. PP reflects your contribution to dustswap.
                </p>
              </div>

              <div className="w-full max-w-sm">
                <label
                  htmlFor="quest-x-username"
                  className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500"
                >
                  X Username
                </label>
                <div className="flex gap-2">
                  <input
                    id="quest-x-username"
                    value={xUsernameInput}
                    onChange={(event) => setXUsernameInput(event.target.value)}
                    placeholder="@DustswapOnBase"
                    disabled={!isConnected || isSavingXUsername}
                    className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveXUsername()}
                    disabled={!isConnected || isSavingXUsername || !xUsernameInput.trim()}
                    className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isSavingXUsername ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <InfoChip label="Completed" value={completedCount.toLocaleString()} />
              <InfoChip
                label="X Account"
                value={isXLinked ? savedXUsername : "Not linked"}
              />
            </div>
          </div>
        </section>

        {message ? (
          <div className="rounded-2xl border border-emerald-200/90 bg-emerald-50/90 px-4 py-3 text-sm text-emerald-700 shadow-[0_16px_38px_rgba(22,163,74,0.08)]">
            {message}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-2xl border border-rose-200/90 bg-rose-50/90 px-4 py-3 text-sm text-rose-700 shadow-[0_16px_38px_rgba(244,63,94,0.08)]">
            {error}
          </div>
        ) : null}

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="inline-flex w-full rounded-[22px] border border-white/80 bg-white/70 p-1 shadow-[0_18px_40px_rgba(148,163,184,0.12)] backdrop-blur-xl sm:w-auto">
              {(["onchain", "social"] as const).map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setCategoryFilter(category)}
                  className={`rounded-[16px] px-4 py-2 text-sm font-semibold transition ${
                    categoryFilter === category
                      ? "bg-sky-600 text-white shadow-[0_12px_24px_rgba(37,99,235,0.2)]"
                      : "text-slate-600 hover:bg-sky-50 hover:text-slate-900"
                  }`}
                >
                  {category === "social" ? "Social" : "Onchain"}
                </button>
              ))}
            </div>

            {categoryFilter === "onchain" ? (
              <button
                type="button"
                onClick={() => void handleOnchainRefresh()}
                disabled={isRefreshing}
                className="inline-flex items-center justify-center rounded-2xl border border-white/80 bg-white/75 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-[0_14px_34px_rgba(148,163,184,0.1)] backdrop-blur-xl transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isRefreshing ? "Verifying..." : "Verify Progress"}
              </button>
            ) : null}
          </div>

          {isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="animate-pulse rounded-[24px] border border-white/80 bg-white/72 p-4 backdrop-blur-xl"
                >
                  <div className="h-3 w-24 rounded bg-slate-200" />
                  <div className="mt-3 h-5 w-2/3 rounded bg-slate-200" />
                  <div className="mt-3 h-3.5 w-full rounded bg-slate-200" />
                  <div className="mt-2 h-3.5 w-4/5 rounded bg-slate-200" />
                  <div className="mt-4 h-20 rounded-2xl bg-slate-200" />
                </div>
              ))}
            </div>
          ) : filteredQuests.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-slate-200/90 bg-white/75 p-7 text-center text-sm text-slate-500 shadow-[0_18px_42px_rgba(148,163,184,0.08)] backdrop-blur-xl">
              {categoryFilter === "onchain"
                ? "No active onchain quests are waiting for this wallet right now."
                : "No active social quests are waiting for this wallet right now."}
            </div>
          ) : categoryFilter === "onchain" ? (
            <div className="space-y-4">
              {onchainSections.map((section) => (
                <section key={section.key} className="space-y-2.5">
                  <SectionBadge label={section.label} count={section.quests.length} />
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {section.quests.map((quest) => renderQuestCard(quest))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredQuests.map((quest) => renderQuestCard(quest))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
