"use client";

import Link from "next/link";
import { startTransition, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import {
  buildXConnectUrl,
  fetchQuestBoard,
  startQuest,
  verifyDelayQuest,
  verifyXPost,
} from "@/lib/quests";
import type { QuestItem } from "@/types/quests";

type CategoryFilter = "social" | "onchain";
type SocialFilter = "all" | "x" | "base";

type PendingState = Record<string, boolean>;
type PostInputState = Record<string, string>;

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

function StatusPill({ quest }: { quest: QuestItem }) {
  const status = quest.progress?.completedAt
    ? "completed"
    : quest.progress?.status || "new";

  const classes =
    status === "completed"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/20"
      : status === "retry_required"
        ? "bg-amber-500/15 text-amber-200 border-amber-400/20"
        : "bg-white/5 text-gray-300 border-white/10";

  return (
    <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] ${classes}`}>
      {status === "completed" ? "Completed" : status === "retry_required" ? "Retry" : "Live"}
    </span>
  );
}

function RewardBadge({ points }: { points: number }) {
  return (
    <div className="rounded-2xl border border-sky-400/15 bg-sky-400/10 px-3 py-2 text-right">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-200/80">
        Reward
      </p>
      <p className="text-sm font-semibold text-sky-100">{formatPoints(points)}</p>
    </div>
  );
}

export function QuestBoard() {
  const { address, isConnected } = useAccount();
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("social");
  const [socialFilter, setSocialFilter] = useState<SocialFilter>("all");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [board, setBoard] = useState<Awaited<ReturnType<typeof fetchQuestBoard>> | null>(null);
  const [pending, setPending] = useState<PendingState>({});
  const [postInputs, setPostInputs] = useState<PostInputState>({});

  async function loadBoard() {
    setIsLoading(true);
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
      setIsLoading(false);
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
      window.history.replaceState({}, "", nextQuery ? `?${nextQuery}` : window.location.pathname);
      startTransition(() => {
        void loadBoard();
      });
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setBoard((current) => (current ? { ...current } : current));
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  const filteredQuests = useMemo(() => {
    const quests = board?.quests || [];
    return quests.filter((quest) => {
      if (quest.category !== categoryFilter) {
        return false;
      }

      if (categoryFilter === "social" && socialFilter !== "all" && quest.platform !== socialFilter) {
        return false;
      }

      return true;
    });
  }, [board?.quests, categoryFilter, socialFilter]);

  const completedCount = (board?.quests || []).filter((quest) => quest.progress?.completedAt).length;
  const linkedXAccount = board?.linkedAccounts?.x;

  async function refreshWithMessage(nextMessage?: string) {
    if (nextMessage) {
      setMessage(nextMessage);
    }
    startTransition(() => {
      void loadBoard();
    });
  }

  async function handleDelayQuestStart(quest: QuestItem) {
    if (!address) {
      setError("Connect your wallet first");
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

      window.open(questUrl);
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

      await loadBoard();
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

  function handleConnectX() {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    const url = buildXConnectUrl(address, `${window.location.origin}/quests`);
    window.open(url);
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-8">
      <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.24),transparent_38%),linear-gradient(180deg,rgba(11,16,32,0.96),rgba(5,7,14,0.96))]">
        <div className="flex flex-col gap-5 p-5 sm:p-7">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="max-w-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.35em] text-sky-200/80">
                Quest Board
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Social and onchain quests that stay editable from admin.
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-gray-300 sm:text-base">
                Start with swap volume, X login and post verification, then keep adding new tasks from the admin manager instead of shipping code every time.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 self-stretch sm:w-auto">
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-gray-400">
                  Completed
                </p>
                <p className="mt-2 text-2xl font-semibold text-white">{completedCount}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-gray-400">
                  X Account
                </p>
                <p className="mt-2 text-sm font-semibold text-white">
                  {linkedXAccount?.username ? `@${linkedXAccount.username}` : "Not linked"}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-white">
                {isConnected
                  ? "Your wallet is connected. You can start and verify quests now."
                  : "Connect your wallet to sync quest progress and rewards."}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                X uses one-time login plus one-call post verification. Base App and soft X tasks use mobile-friendly delay gates.
              </p>
            </div>

            <button
              type="button"
              onClick={handleConnectX}
              disabled={!isConnected}
              className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-sm font-semibold text-sky-100 transition hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {linkedXAccount?.username ? `Linked @${linkedXAccount.username}` : "Connect X"}
            </button>
          </div>
        </div>
      </section>

      {message ? (
        <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex rounded-2xl border border-white/10 bg-white/[0.04] p-1">
            {(["social", "onchain"] as const).map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setCategoryFilter(category)}
                className={`rounded-[14px] px-4 py-2.5 text-sm font-semibold transition ${
                  categoryFilter === category
                    ? "bg-white text-[#030305]"
                    : "text-gray-300 hover:bg-white/10"
                }`}
              >
                {category === "social" ? "Social" : "Onchain"}
              </button>
            ))}
          </div>

          {categoryFilter === "social" ? (
            <div className="inline-flex rounded-2xl border border-white/10 bg-white/[0.04] p-1">
              {(["all", "x", "base"] as const).map((platform) => (
                <button
                  key={platform}
                  type="button"
                  onClick={() => setSocialFilter(platform)}
                  className={`rounded-[14px] px-4 py-2.5 text-sm font-medium transition ${
                    socialFilter === platform
                      ? "bg-sky-400/15 text-sky-100"
                      : "text-gray-300 hover:bg-white/10"
                  }`}
                >
                  {platform === "all" ? "All Social" : platform === "x" ? "X" : "Base App"}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="animate-pulse rounded-[26px] border border-white/10 bg-white/[0.04] p-5"
              >
                <div className="h-4 w-24 rounded bg-white/10" />
                <div className="mt-4 h-7 w-2/3 rounded bg-white/10" />
                <div className="mt-3 h-4 w-full rounded bg-white/10" />
                <div className="mt-2 h-4 w-4/5 rounded bg-white/10" />
                <div className="mt-6 h-11 rounded-2xl bg-white/10" />
              </div>
            ))}
          </div>
        ) : filteredQuests.length === 0 ? (
          <div className="rounded-[26px] border border-dashed border-white/10 bg-white/[0.03] p-8 text-center text-sm text-gray-400">
            No quests match this filter yet.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filteredQuests.map((quest) => {
              const questUrl = normalizeQuestUrl(quest);
              const countdownLabel = getCountdownLabel(quest.progress?.nextVerificationAt);
              const progressValue = Number(quest.progress?.value || 0);
              const percent = getProgressPercent(progressValue, quest.targetValue);
              const isDone = Boolean(quest.progress?.completedAt);
              const isPending = Boolean(pending[quest.id]);
              const canVerifyDelay =
                quest.progress?.nextVerificationAt &&
                new Date(quest.progress.nextVerificationAt).getTime() <= Date.now();

              return (
                <article
                  key={quest.id}
                  className="flex flex-col rounded-[26px] border border-white/10 bg-[linear-gradient(180deg,rgba(18,22,34,0.96),rgba(8,10,16,0.96))] p-5 shadow-[0_16px_60px_rgba(0,0,0,0.28)]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-400">
                        {quest.category} · {quest.platform}
                      </p>
                      <h2 className="mt-3 text-xl font-semibold text-white">{quest.title}</h2>
                    </div>
                    <StatusPill quest={quest} />
                  </div>

                  <p className="mt-3 min-h-[56px] text-sm leading-6 text-gray-300">
                    {quest.description}
                  </p>

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <RewardBadge points={quest.rewardPoints} />
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 text-right">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-500">
                        Goal
                      </p>
                      <p className="text-sm font-semibold text-white">
                        {quest.actionType === "swap_volume"
                          ? `$${quest.targetValue.toLocaleString()}`
                          : quest.actionType === "swap_count"
                            ? `${quest.targetValue.toLocaleString()} swaps`
                            : "1 action"}
                      </p>
                    </div>
                  </div>

                  {quest.actionType === "swap_volume" || quest.actionType === "swap_count" ? (
                    <div className="mt-5 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-400">
                          {quest.actionType === "swap_count" ? "Current swaps" : "Current volume"}
                        </span>
                        <span className="font-semibold text-white">
                          {quest.actionType === "swap_count"
                            ? progressValue.toLocaleString()
                            : `$${progressValue.toLocaleString(undefined, {
                                maximumFractionDigits: 2,
                              })}`}
                        </span>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-[linear-gradient(90deg,#0ea5e9,#38bdf8)]"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <p className="mt-3 text-xs text-gray-400">
                        Swap on DustSwap and this card updates automatically after successful route execution.
                      </p>
                      <Link
                        href={questUrl || "/swap"}
                        className="mt-4 inline-flex w-full items-center justify-center rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-[#030305] transition hover:bg-sky-100"
                      >
                        {isDone ? "View Swap Page" : quest.ctaLabel || "Open Swap"}
                      </Link>
                    </div>
                  ) : quest.verificationType === "x_post_link" ? (
                    <div className="mt-5 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="space-y-3">
                        {quest.rules.composeText ? (
                          <p className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 text-xs leading-6 text-gray-300">
                            {quest.rules.composeText}
                          </p>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            if (questUrl) {
                              window.open(questUrl);
                            }
                          }}
                          disabled={!linkedXAccount?.username || !questUrl}
                          className="w-full rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-sm font-semibold text-sky-100 transition hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {linkedXAccount?.username ? quest.ctaLabel || "Open Composer" : "Connect X First"}
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
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-sky-400/40"
                        />
                        <button
                          type="button"
                          onClick={() => void handleVerifyPost(quest)}
                          disabled={!linkedXAccount?.username || isPending || isDone}
                          className="w-full rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-[#030305] transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isDone ? "Verified" : isPending ? "Verifying..." : "Verify Post"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-5 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <p className="text-xs uppercase tracking-[0.24em] text-gray-500">
                        Soft Verification
                      </p>
                      <p className="mt-2 text-sm leading-6 text-gray-300">
                        Open the destination, do the task, wait 20 seconds, then come back to verify.
                      </p>
                      <div className="mt-4 grid gap-3">
                        <button
                          type="button"
                          onClick={() => void handleDelayQuestStart(quest)}
                          disabled={!questUrl || isPending || isDone}
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isDone ? "Task Completed" : isPending ? "Opening..." : quest.ctaLabel || "Open Task"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelayVerify(quest)}
                          disabled={!canVerifyDelay || isPending || isDone}
                          className="w-full rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-[#030305] transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {isDone
                            ? "Verified"
                            : isPending
                              ? "Checking..."
                              : countdownLabel || "Verify"}
                        </button>
                        {quest.progress?.status === "retry_required" ? (
                          <p className="text-xs text-amber-200">
                            One more revisit is needed for this task before it clears.
                          </p>
                        ) : null}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
