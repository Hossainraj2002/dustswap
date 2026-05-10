"use client";

import Link from "next/link";
import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { Hex } from "viem";
import {
  buildDiscordAccountMessage,
  buildXAccountMessage,
  createXConnectUrl,
  fetchQuestBoard,
  getDiscordConnectUrl,
  syncSwapQuestActivity,
  startQuest,
  verifyDiscordJoin,
  verifyDelayQuest,
  verifyXPost,
} from "@/lib/quests";
import { emitDataInvalidation, subscribeToDataInvalidation } from "@/lib/clientEvents";
import { clearPointsSummaryCache } from "@/lib/points";
import { PremiumQuestBackground } from "@/components/quests/PremiumQuestBackground";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import type { QuestItem } from "@/types/quests";

type CategoryFilter = "social" | "onchain";
type PendingState = Record<string, boolean>;
type PostInputState = Record<string, string>;
type QuestInlineErrorState = Record<string, string>;
type PostVerificationFailureState = Record<string, boolean>;

const GENERAL_CAMPAIGN_KEY = "general";

const CATEGORY_TABS = [
  { key: "social", label: "Social" },
  { key: "onchain", label: "Onchain" },
] as const;

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

function formatDiscordName(input?: {
  displayName?: string | null;
  username?: string | null;
}) {
  return input?.displayName || input?.username || "Discord connected";
}

function getDiscordInviteUrl(quest?: QuestItem | null) {
  return (
    process.env.NEXT_PUBLIC_DISCORD_INVITE_URL ||
    quest?.ctaUrl ||
    (typeof quest?.rules.externalUrl === "string" ? quest.rules.externalUrl : "") ||
    ""
  );
}

function getDiscordVerifyMessage(error?: string | null) {
  if (error === "DISCORD_NOT_CONNECTED") {
    return "Connect Discord first.";
  }

  if (error === "DISCORD_USER_NOT_IN_GUILD") {
    return "Join our Discord, then verify again.";
  }

  if (error === "DISCORD_RATE_LIMITED") {
    return "Verification is rate limited. Try again shortly.";
  }

  return "Discord verification is temporarily unavailable.";
}

function getDiscordConnectMessage(error?: string | null) {
  if (!error) {
    return "Discord connection failed. Please try again.";
  }

  if (error === "DISCORD_OAUTH_STATE_INVALID") {
    return "Discord connection expired. Please try again.";
  }

  if (error === "DISCORD_OAUTH_EXCHANGE_FAILED") {
    return "Discord connection failed. Check the Discord app secret and redirect URL in Railway.";
  }

  if (error === "DISCORD_NOT_CONFIGURED") {
    return "Discord is not configured on the API server.";
  }

  return getDiscordVerifyMessage(error);
}

function getPostRequirementHint(quest: QuestItem) {
  const ruleTokens = Array.isArray(quest.rules.requiredAnyOf)
    ? quest.rules.requiredAnyOf
    : [
        ...(Array.isArray(quest.rules.requiredMentionsAny)
          ? quest.rules.requiredMentionsAny
          : []),
        ...(Array.isArray(quest.rules.requiredHashtags)
          ? quest.rules.requiredHashtags
          : []),
        ...(quest.rules.requiredMention ? [quest.rules.requiredMention] : []),
      ];

  const cleaned = ruleTokens
    .map((value) => String(value).trim())
    .filter(Boolean);

  if (cleaned.length === 0) {
    return null;
  }

  return `Add at least one: ${cleaned.join("  ")}`;
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

function formatEndCountdown(endsAt: string) {
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) {
    return "Ending";
  }

  const totalMinutes = Math.ceil(diff / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `Ending in ${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `Ending in ${hours}h ${minutes}m`;
  }

  return `Ending in ${minutes}m`;
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

  if (quest.progress?.status === "pending_review") {
    return (
      <span className="rounded-full border border-sky-200/90 bg-sky-50/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-700">
        Pending Review
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

  if (quest.endsAt) {
    return (
      <span className="rounded-full border border-rose-200/90 bg-rose-50/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-rose-700">
        {formatEndCountdown(quest.endsAt)}
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
  const { signMessageAsync } = useSignMessage();
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("social");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [board, setBoard] = useState<Awaited<ReturnType<typeof fetchQuestBoard>> | null>(null);
  const [pending, setPending] = useState<PendingState>({});
  const [postInputs, setPostInputs] = useState<PostInputState>({});
  const [questInlineErrors, setQuestInlineErrors] = useState<QuestInlineErrorState>({});
  const [postVerificationFailures, setPostVerificationFailures] =
    useState<PostVerificationFailureState>({});
  const [isConnectingX, setIsConnectingX] = useState(false);
  const [isConnectingDiscord, setIsConnectingDiscord] = useState(false);
  const [pendingDiscordAuthUrl, setPendingDiscordAuthUrl] = useState<string | null>(null);

  const loadBoard = useCallback(
    async (options?: { silent?: boolean }) => {
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
    },
    [address]
  );

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setBoard((current) => (current ? { ...current } : current));
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleFocus = () => {
      void loadBoard({ silent: true });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadBoard({ silent: true });
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadBoard]);

  useEffect(() => {
    return subscribeToDataInvalidation("quests", () => {
      startTransition(() => {
        void loadBoard({ silent: true });
      });
    });
  }, [loadBoard]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleDiscordOAuthMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const payload = event.data as {
        type?: string;
        success?: boolean;
        error?: string | null;
        username?: string | null;
      };

      if (payload?.type !== "dustswap:discord-oauth") {
        return;
      }

      setIsConnectingDiscord(false);
      setPendingDiscordAuthUrl(null);
      if (payload.success) {
        setMessage(
          payload.username
            ? `Discord connected as ${payload.username}.`
            : "Discord connected."
        );
        emitDataInvalidation(["quests", "profile"], "discord-connected");
        void loadBoard({ silent: true });
        return;
      }

      setError(getDiscordConnectMessage(payload.error));
      void loadBoard({ silent: true });
    };

    window.addEventListener("message", handleDiscordOAuthMessage);
    return () => window.removeEventListener("message", handleDiscordOAuthMessage);
  }, [loadBoard]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const linked = params.get("discord_linked");
    const errorParam = params.get("discord_error");
    const username = params.get("discord_username");
    if (!linked && !errorParam) {
      return;
    }

    if (linked === "1") {
      setPendingDiscordAuthUrl(null);
      setMessage(username ? `Discord connected as ${username}.` : "Discord connected.");
      emitDataInvalidation(["quests", "profile"], "discord-connected");
      void loadBoard({ silent: true });
    } else {
      setError(getDiscordConnectMessage(errorParam));
    }

    params.delete("discord_linked");
    params.delete("discord_error");
    params.delete("discord_username");
    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [loadBoard]);

  const linkedXAccount = board?.linkedAccounts?.x;
  const isXConnected = linkedXAccount?.connected === true;
  const savedXUsername = formatXUsernameDisplay(linkedXAccount?.username);
  const linkedDiscordAccount = board?.linkedAccounts?.discord;
  const isDiscordConnected = linkedDiscordAccount?.connected === true;
  const isDiscordJoined = linkedDiscordAccount?.joined === true;
  const discordDisplayName = formatDiscordName(linkedDiscordAccount);

  const visibleQuests = useMemo(() => {
    return (board?.quests || []).filter(
      (quest) => quest.campaignKey === GENERAL_CAMPAIGN_KEY
    );
  }, [board?.quests]);

  const filteredQuests = useMemo(() => {
    return visibleQuests.filter((quest) => {
      if (quest.category !== categoryFilter) {
        return false;
      }

      if (quest.progressWindow === "once" && quest.progress?.completedAt) {
        return false;
      }

      return true;
    });
  }, [categoryFilter, visibleQuests]);

  const onchainSections = useMemo(() => {
    return ONCHAIN_WINDOWS.map((section) => ({
      ...section,
      quests: filteredQuests.filter(
        (quest) =>
          quest.category === "onchain" && quest.progressWindow === section.key
      ),
    })).filter((section) => section.quests.length > 0);
  }, [filteredQuests]);

  const completedCount = visibleQuests.filter(
    (quest) => quest.progress?.completedAt
  ).length;

  function refreshWithMessage(nextMessage?: string, reason = "quest-update") {
    if (nextMessage) {
      setMessage(nextMessage);
    }

    emitDataInvalidation("quests", reason);
  }

  function clearQuestInlineError(questId: string) {
    setQuestInlineErrors((current) => {
      if (!current[questId]) {
        return current;
      }

      const next = { ...current };
      delete next[questId];
      return next;
    });
    setPostVerificationFailures((current) => {
      if (!current[questId]) {
        return current;
      }

      const next = { ...current };
      delete next[questId];
      return next;
    });
  }

  function clearPostVerificationFailure(questId: string) {
    setPostVerificationFailures((current) => {
      if (!current[questId]) {
        return current;
      }

      const next = { ...current };
      delete next[questId];
      return next;
    });
  }

  function setQuestInlineError(questId: string, nextError: string) {
    setQuestInlineErrors((current) => ({
      ...current,
      [questId]: nextError,
    }));
  }

  async function handleOnchainRefresh() {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    setIsRefreshing(true);
    setMessage("Checking your latest swap progress...");
    let syncIssue: string | null = null;

    try {
      const response = await syncSwapQuestActivity(address, { force: true });
      if (!response.success) {
        throw new Error(response.error || "Failed to sync recent swaps");
      }

      if ((response.importedHashes?.length || 0) > 0 || (response.completedQuests?.length || 0) > 0) {
        clearPointsSummaryCache(address);
      }

      emitDataInvalidation("quests", "quest-manual-sync");

      if ((response.importedHashes?.length || 0) > 0) {
        emitDataInvalidation("profile", "quest-manual-sync:swap-imported");
        emitDataInvalidation("leaderboard", "quest-manual-sync:swap-imported");
      }

      if ((response.completedQuests?.length || 0) > 0) {
        emitDataInvalidation(["leaderboard", "points"], "quest-manual-sync:quest-completed");
      }
    } catch (syncError) {
      syncIssue = getDisplayError(syncError);
    } finally {
      if (syncIssue) {
        setError(syncIssue);
      }
      setIsRefreshing(false);
    }
  }

  function openExternal(url: string) {
    if (typeof window === "undefined") {
      return;
    }

    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
    }
  }

  async function handleConnectX(returnPath = "/quests") {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    if (isConnectingX) {
      return;
    }

    setError(null);
    setMessage(null);
    setIsConnectingX(true);

    try {
      const returnTo =
        typeof window !== "undefined"
          ? new URL(returnPath, window.location.origin).toString()
          : returnPath;
      const messageToSign = buildXAccountMessage(address, "connect-x");
      const signature = (await signMessageAsync({
        message: messageToSign,
      })) as Hex;
      const response = await createXConnectUrl({
        address,
        message: messageToSign,
        signature,
        returnTo,
      });

      if (!response.success || !response.authUrl) {
        throw new Error(response.error || "Failed to start X connection");
      }

      window.location.assign(response.authUrl);
    } catch (connectError) {
      setError(getDisplayError(connectError));
      setIsConnectingX(false);
    }
  }

  async function handleConnectDiscord() {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    if (isConnectingDiscord) {
      return;
    }

    setError(null);
    setMessage("Approve the wallet signature first. Discord will open after that.");
    setIsConnectingDiscord(true);
    setPendingDiscordAuthUrl(null);

    try {
      const returnTo =
        typeof window !== "undefined"
          ? new URL("/discord/oauth-complete", window.location.origin).toString()
          : "/discord/oauth-complete";
      const messageToSign = buildDiscordAccountMessage(address, "connect-discord");
      const signature = (await signMessageAsync({
        message: messageToSign,
      })) as Hex;

      const authUrl = getDiscordConnectUrl({
        address,
        message: messageToSign,
        signature,
        returnTo,
      });
      const authWindow =
        typeof window !== "undefined"
          ? window.open(authUrl, "dustswap-discord-oauth")
          : null;

      if (!authWindow) {
        setPendingDiscordAuthUrl(authUrl);
        setMessage("Wallet approved. Click Open Discord Authorization to continue.");
        setIsConnectingDiscord(false);
        return;
      }

      setMessage("Finish Discord authorization in the new window.");
      const authWindowCheckId = window.setInterval(() => {
        if (authWindow.closed) {
          window.clearInterval(authWindowCheckId);
          setIsConnectingDiscord(false);
        }
      }, 600);
    } catch (connectError) {
      setError(getDisplayError(connectError));
      setIsConnectingDiscord(false);
    }
  }

  function handleOpenPendingDiscordAuth() {
    if (!pendingDiscordAuthUrl || typeof window === "undefined") {
      return;
    }

    const authWindow = window.open(pendingDiscordAuthUrl, "dustswap-discord-oauth");
    if (!authWindow) {
      setError("Your browser blocked the Discord window. Allow pop-ups for DustSwap and try again.");
      return;
    }

    setError(null);
    setMessage("Finish Discord authorization in the new window.");
    setIsConnectingDiscord(true);
    const authWindowCheckId = window.setInterval(() => {
      if (authWindow.closed) {
        window.clearInterval(authWindowCheckId);
        setIsConnectingDiscord(false);
      }
    }, 600);
  }

  async function handleVerifyDiscordJoin(quest: QuestItem) {
    if (!address) {
      setError("Connect your wallet first");
      return;
    }

    if (!isDiscordConnected) {
      await handleConnectDiscord();
      return;
    }

    setPending((current) => ({ ...current, [quest.id]: true }));
    setError(null);
    setMessage(null);

    try {
      const response = await verifyDiscordJoin({
        address,
        questId: quest.id,
      });

      if (!response.success) {
        throw new Error(response.message || getDiscordVerifyMessage(response.error));
      }

      clearPointsSummaryCache(address);
      refreshWithMessage(
        `Discord verified. You earned ${formatPoints(response.awardedPoints || 0)}.`,
        "discord-join-verified"
      );
      emitDataInvalidation(["leaderboard", "points", "profile"], "discord-join-verified");
    } catch (verifyError) {
      setError(getDisplayError(verifyError));
    } finally {
      setPending((current) => ({ ...current, [quest.id]: false }));
    }
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

    if (quest.platform === "x" && !isXConnected && quest.actionType !== "follow") {
      await handleConnectX("/quests");
      return;
    }

    setPending((current) => ({ ...current, [quest.id]: true }));
    openExternal(questUrl);

    if (quest.platform === "x" && !isXConnected && quest.actionType === "follow") {
      setMessage("Follow on X, then connect X here to verify.");
      setPending((current) => ({ ...current, [quest.id]: false }));
      return;
    }

    try {
      const response = await startQuest(quest.id, address);
      if (!response.success) {
        throw new Error(response.error || "Failed to start quest");
      }

      refreshWithMessage(
        response.status === "pending_review"
          ? "Task submitted for review."
          : "Quest opened. Come back when verify unlocks.",
        "quest-started"
      );
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

    if (quest.platform === "x" && !isXConnected) {
      await handleConnectX("/quests");
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
        emitDataInvalidation("quests", "quest-retry-required");
      } else if (!response.success) {
        throw new Error(response.error || "Verification failed");
      } else if (response.status === "pending_review") {
        setMessage(response.message || "Task submitted for review.");
        emitDataInvalidation("quests", "delay-quest-pending-review");
      } else {
        setMessage(`Quest completed. You earned ${formatPoints(response.awardedPoints || 0)}.`);
        clearPointsSummaryCache(address);
        emitDataInvalidation(["leaderboard", "points", "quests"], "delay-quest-verified");
      }
    } catch (verifyError) {
      setError(getDisplayError(verifyError));
    } finally {
      setPending((current) => ({ ...current, [quest.id]: false }));
    }
  }

  async function handleVerifyPost(quest: QuestItem) {
    setError(null);
    setMessage(null);
    clearQuestInlineError(quest.id);

    if (!address) {
      clearPostVerificationFailure(quest.id);
      setQuestInlineError(quest.id, "Connect your wallet first");
      return;
    }

    if (!isXConnected) {
      clearPostVerificationFailure(quest.id);
      await handleConnectX("/quests");
      return;
    }

    const postUrl = postInputs[quest.id]?.trim();
    if (!postUrl) {
      clearPostVerificationFailure(quest.id);
      setQuestInlineError(quest.id, "Paste your X post link first");
      return;
    }

    setPending((current) => ({ ...current, [quest.id]: true }));

    try {
      const response = await verifyXPost(quest.id, address, postUrl);
      if (!response.success) {
        throw new Error(response.error || "Post verification failed");
      }

      setPostInputs((current) => ({ ...current, [quest.id]: "" }));
      clearQuestInlineError(quest.id);
      clearPostVerificationFailure(quest.id);
      clearPointsSummaryCache(address);
      refreshWithMessage(
        `Post verified. You earned ${formatPoints(response.awardedPoints || 0)}.`,
        "x-post-verified"
      );
      emitDataInvalidation(["leaderboard", "points"], "x-post-verified");
    } catch (verifyError) {
      setPostVerificationFailures((current) => ({
        ...current,
        [quest.id]: true,
      }));
      setQuestInlineError(quest.id, getDisplayError(verifyError));
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
    const isPendingReview = quest.progress?.status === "pending_review";
    const isPending = Boolean(pending[quest.id]);
    const inlineError = questInlineErrors[quest.id];
    const canVerifyDelay =
      quest.progress?.nextVerificationAt &&
      new Date(quest.progress.nextVerificationAt).getTime() <= Date.now();
    const isXQuest = quest.platform === "x";
    const isDiscordQuest =
      quest.platform === "discord" ||
      quest.actionType === "join_discord" ||
      quest.verificationType === "discord_guild_member";
    const xLocked = isXQuest && !isXConnected;
    const discordLocked = isDiscordQuest && !isDiscordConnected;
    const isReplyQuest = isXQuest && quest.actionType === "reply";
    const isPostLinkQuest = quest.verificationType === "x_post_link" || isReplyQuest;
    const discordInviteUrl = getDiscordInviteUrl(quest);
    const postRequirementHint = getPostRequirementHint(quest);
    const showPostRequirementHint =
      !xLocked &&
      Boolean(postInputs[quest.id]?.trim()) &&
      Boolean(postRequirementHint) &&
      Boolean(postVerificationFailures[quest.id]);
    const primaryLabel =
      xLocked && quest.actionType !== "follow"
        ? "Connect X"
        : discordLocked
          ? "Connect Discord"
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
        ) : isDiscordQuest ? (
          <div className="rounded-[20px] border border-slate-200/80 bg-white/88 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
            <div className="space-y-3">
              {isDiscordConnected ? (
                <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                  {linkedDiscordAccount?.profileImageUrl ? (
                    <img
                      src={linkedDiscordAccount.profileImageUrl}
                      alt="Connected Discord profile"
                      className="h-10 w-10 rounded-full border border-white object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-xs font-black text-slate-500">
                      D
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-950">
                      {discordDisplayName}
                    </p>
                    <p className="text-[11px] font-medium text-slate-500">
                      {isDone || isDiscordJoined
                        ? "Joined Discord verified"
                        : "Not joined yet"}
                    </p>
                  </div>
                </div>
              ) : null}

              {!isDiscordConnected ? (
                <>
                  <button
                    type="button"
                    onClick={() => void handleConnectDiscord()}
                    disabled={isConnectingDiscord}
                    className="w-full rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isConnectingDiscord ? "Connecting..." : "Connect Discord"}
                  </button>
                  {pendingDiscordAuthUrl ? (
                    <button
                      type="button"
                      onClick={handleOpenPendingDiscordAuth}
                      className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
                    >
                      Open Discord Authorization
                    </button>
                  ) : null}
                </>
              ) : (
                <div className="grid gap-2">
                  {!isDone && !isDiscordJoined ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (discordInviteUrl) {
                          openExternal(discordInviteUrl);
                        }
                      }}
                      disabled={!discordInviteUrl}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Join Discord
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void handleVerifyDiscordJoin(quest)}
                    disabled={isPending || isDone || isConnectingDiscord}
                    className="w-full rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isDone
                      ? "Verified"
                      : isPending
                        ? "Checking..."
                        : "Verify Join"}
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : isPostLinkQuest ? (
          <div className="rounded-[20px] border border-slate-200/80 bg-white/88 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
            <div className="space-y-2.5">
              {quest.rules.composeText ? (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-600">
                  {quest.rules.composeText}
                </p>
              ) : null}
              {showPostRequirementHint ? (
                <p className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-medium leading-5 text-rose-700">
                  {postRequirementHint}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  if (xLocked) {
                    void handleConnectX("/quests");
                    return;
                  }

                  clearPostVerificationFailure(quest.id);
                  clearQuestInlineError(quest.id);
                  if (questUrl) {
                    openExternal(questUrl);
                  }
                }}
                disabled={!questUrl}
                className="w-full rounded-2xl border border-sky-200 bg-white px-4 py-2.5 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {xLocked ? "Connect X" : quest.ctaLabel || (isReplyQuest ? "Open Post" : "Open Composer")}
              </button>
              <input
                value={postInputs[quest.id] || ""}
                onChange={(event) =>
                  {
                    clearQuestInlineError(quest.id);
                    clearPostVerificationFailure(quest.id);
                    setPostInputs((current) => ({
                      ...current,
                      [quest.id]: event.target.value,
                    }));
                  }
                }
                placeholder={isReplyQuest ? "Paste your X reply link" : "Paste your X post link"}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-sky-300"
              />
              {inlineError ? (
                <p className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-medium leading-5 text-rose-700">
                  {inlineError}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void handleVerifyPost(quest)}
                disabled={isPending || isDone || isConnectingX}
                className="w-full rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {xLocked
                  ? "Connect X"
                  : isDone
                    ? "Verified"
                    : isPending
                      ? "Verifying..."
                      : isReplyQuest
                        ? "Verify Reply"
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
                disabled={(!questUrl && !xLocked) || isPending || isDone || isPendingReview}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDone
                  ? "Task Completed"
                  : isPendingReview
                    ? "Pending Review"
                    : isPending
                      ? "Opening..."
                      : primaryLabel}
              </button>
              <button
                type="button"
                onClick={() => void handleDelayVerify(quest)}
                disabled={
                  (!xLocked && !canVerifyDelay) ||
                  isPending ||
                  isDone ||
                  isConnectingX ||
                  isPendingReview
                }
                className="w-full rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {xLocked
                  ? "Connect X"
                  : isDone
                    ? "Verified"
                    : isPendingReview
                      ? "Pending Review"
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
    <div
      className="relative isolate overflow-hidden"
      style={{ minHeight: "calc(100dvh - 74px)" }}
    >
      <PremiumQuestBackground />

      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 py-3 sm:px-5 sm:py-5">
        <section className="overflow-hidden rounded-[30px] border border-sky-100/90 bg-[radial-gradient(circle_at_top_left,rgba(0,82,255,0.16),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(14,165,233,0.18),transparent_36%),linear-gradient(135deg,#ffffff_0%,#f0f7ff_55%,#e0f2fe_100%)] shadow-[0_24px_80px_rgba(0,82,255,0.1)] backdrop-blur-xl">
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-2xl">
                <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-slate-950 sm:text-[34px]">
                  Social and onchain quests.
                </h1>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
                  Start completing quests and earn Particle Points PP from every action. PP reflects your contribution to dustswap.
                </p>
              </div>

              <div className="w-full max-w-sm">
                {!isConnected ? (
                  <div className="rounded-[24px] border border-white/80 bg-white/82 p-3 shadow-[0_18px_44px_rgba(0,82,255,0.08)]">
                    <WalletConnectButton
                      fullWidth
                      connectLabel="Connect Wallet"
                      description="Connect your wallet to start quests and connect your X account."
                      className="min-h-[46px] rounded-2xl border-sky-200 bg-[#0052ff] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(0,82,255,0.2)] hover:border-sky-300 hover:bg-sky-600 hover:text-white"
                    />
                  </div>
                ) : !isXConnected ? (
                  <div className="rounded-[24px] border border-white/80 bg-white/82 p-3 shadow-[0_18px_44px_rgba(0,82,255,0.08)]">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                      X Account
                    </p>
                    {savedXUsername ? (
                      <p className="mb-2 truncate text-xs font-medium text-slate-500">
                        Legacy saved: {savedXUsername}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleConnectX("/quests")}
                      disabled={isConnectingX}
                      className="inline-flex w-full shrink-0 items-center justify-center rounded-2xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isConnectingX ? "Connecting..." : "Connect X"}
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    <InfoChip label="Completed" value={completedCount.toLocaleString()} />
                    <InfoChip label="X Account" value={savedXUsername} />
                    <InfoChip
                      label="Discord"
                      value={isDiscordConnected ? discordDisplayName : "Not connected"}
                    />
                  </div>
                )}
              </div>
            </div>

            {!isXConnected ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <InfoChip label="Completed" value={completedCount.toLocaleString()} />
              <InfoChip
                label="X Account"
                value={savedXUsername ? `${savedXUsername} (legacy)` : "Not connected"}
              />
              <InfoChip
                label="Discord"
                value={isDiscordConnected ? discordDisplayName : "Not connected"}
              />
            </div>
            ) : null}
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
              {CATEGORY_TABS.map((category) => (
                <button
                  key={category.key}
                  type="button"
                  onClick={() => setCategoryFilter(category.key)}
                  className={`rounded-[16px] px-4 py-2 text-sm font-semibold transition ${
                    categoryFilter === category.key
                      ? "bg-sky-600 text-white shadow-[0_12px_24px_rgba(37,99,235,0.2)]"
                      : "text-slate-600 hover:bg-sky-50 hover:text-slate-900"
                  }`}
                >
                  {category.label}
                </button>
              ))}
            </div>

            {categoryFilter !== "social" ? (
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
