"use client";

import { useOpenUrl } from "@coinbase/onchainkit/minikit";
import Link from "next/link";
import { startTransition, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import {
  buildXConnectUrl,
  fetchQuestBoard,
  syncSwapQuestActivity,
  startQuest,
  verifyDelayQuest,
  verifyXPost,
} from "@/lib/quests";
import type { QuestItem } from "@/types/quests";

type CategoryFilter = "social" | "onchain";
type PendingState = Record<string, boolean>;
type PostInputState = Record<string, string>;

const SYNC_NOW_EVENT = "dustswap:quest-sync-now";
const SWAP_RECORDED_EVENT = "dustswap:quest-swap-recorded";

const ONCHAIN_WINDOWS = [
  {
    key: "once",
    label: "Once",
    description: "Permanent milestones that disappear after you clear them.",
  },
  {
    key: "daily",
    label: "Daily",
    description: "Tracks swaps from 00:00 to 00:00 UTC and resets every day.",
  },
  {
    key: "weekly",
    label: "Weekly",
    description: "Tracks swaps from Monday 00:00 UTC to Sunday 23:59 UTC.",
  },
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
    return "Ready to verify";
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

function StatusPill({ quest }: { quest: QuestItem }) {
  if (quest.progress?.completedAt) {
    return (
      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
        Completed
      </span>
    );
  }

  if (quest.progress?.status === "retry_required") {
    return (
      <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
        Retry
      </span>
    );
  }

  if (quest.progressWindow === "daily" || quest.progressWindow === "weekly") {
    return (
      <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-700">
        {formatResetCountdown(quest.progressWindow)}
      </span>
    );
  }

  return (
    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
      Open
    </span>
  );
}

function WindowPill({ quest }: { quest: QuestItem }) {
  return (
    <span className="rounded-full border border-sky-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">
      {formatWindowLabel(quest.progressWindow)}
    </span>
  );
}

function CompletedStamp() {
  return (
    <div className="pointer-events-none absolute inset-x-[-8%] top-8 rotate-[-10deg] border-y border-emerald-200 bg-emerald-50/95 py-1.5 text-center text-[10px] font-black tracking-[0.55em] text-emerald-700">
      COMPLETED
    </div>
  );
}

function RewardBadge({ points }: { points: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        Reward
      </p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{formatPoints(points)}</p>
    </div>
  );
}

export function QuestBoard() {
  const { address, isConnected } = useAccount();
  const openUrl = useOpenUrl();
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("onchain");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [board, setBoard] = useState<Awaited<ReturnType<typeof fetchQuestBoard>> | null>(null);
  const [pending, setPending] = useState<PendingState>({});
  const [postInputs, setPostInputs] = useState<PostInputState>({});

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
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("x_linked");
    const username = params.get("x_username");
    const xError = params.get("x_error");

    if (linked === "1") {
      setMessage(username ? `X linked as @${username}` : "X account linked");
    }

    if (xError) {
      setError(xError);
    }

    if (linked || xError) {
      params.delete("x_linked");
      params.delete("x_username");
      params.delete("x_error");
      const nextQuery = params.toString();
      window.history.replaceState(
        {},
        "",
        nextQuery ? `?${nextQuery}` : window.location.pathname
      );
      startTransition(() => {
        void loadBoard({ silent: true });
      });
    }
  }, []);

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
  }, [address]);

  const linkedXAccount = board?.linkedAccounts?.x;
  const isXLinked = Boolean(linkedXAccount?.username);

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

  function openExternal(url: string) {
    openUrl(url);
  }

  function handleConnectX() {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    const url = buildXConnectUrl(address, `${window.location.origin}/quests`);
    openExternal(url);
  }

  async function handleDelayQuestStart(quest: QuestItem) {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    if (quest.platform === "x" && !isXLinked) {
      handleConnectX();
      return;
    }

    const questUrl = normalizeQuestUrl(quest);
    if (!questUrl) {
      setError("This quest is missing a destination URL");
      return;
    }

    setPending((current) => ({ ...current, [quest.id]: true }));

    try {
      const response = await startQuest(quest.id, address);
      if (!response.success) {
        throw new Error(response.error || "Failed to start quest");
      }

      openExternal(questUrl);
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
      setError("Connect X first before verifying X quests.");
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
      setError("Connect X first before verifying X quests.");
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
    const isOnchain = quest.category === "onchain";
    const isXQuest = quest.platform === "x";
    const xLocked = isXQuest && !isXLinked;
    const primaryLabel = xLocked
      ? "Connect X First"
      : quest.ctaLabel || (isOnchain ? "Open Swap" : "Open Task");

    return (
      <article
        key={quest.id}
        className="relative flex flex-col gap-4 overflow-hidden rounded-[26px] border border-slate-200 bg-white p-4 shadow-[0_14px_40px_rgba(15,23,42,0.08)]"
      >
        {isDone ? <CompletedStamp /> : null}

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
              {quest.category} / {quest.platform}
            </p>
            <h2 className="mt-2 text-lg font-semibold text-slate-950">{quest.title}</h2>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <WindowPill quest={quest} />
            <StatusPill quest={quest} />
          </div>
        </div>

        <p className="text-sm leading-6 text-slate-600">{quest.description}</p>

        <div className="grid grid-cols-2 gap-3">
          <RewardBadge points={quest.rewardPoints} />
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Goal
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900">
              {quest.actionType === "swap_volume"
                ? `$${quest.targetValue.toLocaleString()}`
                : quest.actionType === "swap_count"
                  ? `${quest.targetValue.toLocaleString()} swaps`
                  : "1 action"}
            </p>
          </div>
        </div>

        {quest.actionType === "swap_volume" || quest.actionType === "swap_count" ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">
                {quest.actionType === "swap_count" ? "Current swaps" : "Current volume"}
              </span>
              <span className="font-semibold text-slate-900">
                {quest.actionType === "swap_count"
                  ? progressValue.toLocaleString()
                  : `$${progressValue.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}`}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#2563eb,#38bdf8)]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Volume tracking can take up to 10 minutes.
            </p>
            <div className="mt-4 flex gap-3">
              <Link
                href={questUrl || "/swap"}
                className="inline-flex flex-1 items-center justify-center rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700"
              >
                {isDone ? "View Swap Page" : primaryLabel}
              </Link>
              <button
                type="button"
                onClick={() => void handleOnchainRefresh()}
                disabled={isRefreshing}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isRefreshing ? "Checking" : "Verify"}
              </button>
            </div>
          </div>
        ) : quest.verificationType === "x_post_link" ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="space-y-3">
              {quest.rules.composeText ? (
                <p className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs leading-6 text-slate-600">
                  {quest.rules.composeText}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  if (xLocked) {
                    handleConnectX();
                    return;
                  }

                  if (questUrl) {
                    openExternal(questUrl);
                  }
                }}
                disabled={!questUrl}
                className="w-full rounded-2xl border border-sky-200 bg-white px-4 py-2.5 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {xLocked ? "Connect X First" : quest.ctaLabel || "Open Composer"}
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
                  ? "Connect X First"
                  : isDone
                    ? "Verified"
                    : isPending
                      ? "Verifying..."
                      : "Verify Post"}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              Soft Verification
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Open the destination, do the task, wait 20 seconds, then come back to verify.
            </p>
            {xLocked ? (
              <p className="mt-2 text-xs text-slate-500">
                Connect X first to unlock this X quest.
              </p>
            ) : null}
            <div className="mt-4 grid gap-3">
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
                  ? "Connect X First"
                  : isDone
                    ? "Verified"
                    : isPending
                      ? "Checking..."
                      : countdownLabel || "Verify"}
              </button>
              {quest.progress?.status === "retry_required" ? (
                <p className="text-xs text-amber-700">
                  One more revisit is needed for this task before it clears.
                </p>
              ) : null}
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <section className="overflow-hidden rounded-[28px] border border-sky-100 bg-[linear-gradient(180deg,#f8fbff,#eef6ff)] shadow-[0_20px_60px_rgba(37,99,235,0.08)]">
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-sky-700/70">
                Quest Board
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                Premium quests, cleaner mobile flow.
              </h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Earn Particle Points from social and onchain actions without leaving the quest board feeling crowded.
              </p>
            </div>

            <button
              type="button"
              onClick={handleConnectX}
              disabled={!isConnected}
              className="rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isXLinked ? `Linked @${linkedXAccount?.username}` : "Connect X"}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                Completed
              </p>
              <p className="mt-1 text-xl font-semibold text-slate-950">{completedCount}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                X Account
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-900">
                {isXLinked ? `@${linkedXAccount?.username}` : "Not linked"}
              </p>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            {isConnected
              ? "Your wallet is connected. You can start and verify quests now."
              : "Connect your wallet to sync quest progress and rewards."}
          </div>
        </div>
      </section>

      {message ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
            {(["onchain", "social"] as const).map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setCategoryFilter(category)}
                className={`rounded-[14px] px-4 py-2 text-sm font-semibold transition ${
                  categoryFilter === category
                    ? "bg-sky-600 text-white"
                    : "text-slate-600 hover:bg-sky-50"
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
              className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isRefreshing ? "Verifying..." : "Verify Progress"}
            </button>
          ) : null}
        </div>

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="animate-pulse rounded-[26px] border border-slate-200 bg-white p-4"
              >
                <div className="h-4 w-24 rounded bg-slate-200" />
                <div className="mt-3 h-6 w-2/3 rounded bg-slate-200" />
                <div className="mt-3 h-4 w-full rounded bg-slate-200" />
                <div className="mt-2 h-4 w-4/5 rounded bg-slate-200" />
                <div className="mt-5 h-10 rounded-2xl bg-slate-200" />
              </div>
            ))}
          </div>
        ) : filteredQuests.length === 0 ? (
          <div className="rounded-[26px] border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            {categoryFilter === "onchain"
              ? "No active onchain quests are waiting for this wallet right now."
              : "No active social quests are waiting for this wallet right now."}
          </div>
        ) : categoryFilter === "onchain" ? (
          <div className="space-y-5">
            {onchainSections.map((section) => (
              <section key={section.key} className="space-y-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-sky-700">
                      {section.label}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">{section.description}</p>
                  </div>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    {section.quests.length} quest{section.quests.length === 1 ? "" : "s"}
                  </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {section.quests.map((quest) => renderQuestCard(quest))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filteredQuests.map((quest) => renderQuestCard(quest))}
          </div>
        )}
      </section>
    </div>
  );
}
