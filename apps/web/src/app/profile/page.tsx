"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pay } from "@base-org/account/payment";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSignMessage,
  useWalletClient,
} from "wagmi";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { DailyCheckInModule } from "@/components/profile/DailyCheckInModule";
import { ProfileCompletionGuide } from "@/components/profile/ProfileCompletionGuide";
import {
  ProfileSettingsModal,
  type ProfileSettingsFocusTarget,
  type ProfileSettingsInitialSection,
} from "@/components/profile/ProfileSettingsModal";
import { WalletLinkPromo } from "@/components/profile/WalletLinkPromo";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ThemeLongLogo } from "@/components/ThemeLongLogo";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { useBaseChainSwitch } from "@/hooks/useBaseChainSwitch";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import {
  applyReferralCode,
  clearPointsSummaryCache,
  fetchPointsSummary,
  performDailyCheckIn,
  previewReferralCode,
  resetBrokenStreak,
  saveBrokenStreak,
  type PointsBalance,
  type PointsSummaryResponse,
  type ReferralStats,
  type UserStats,
} from "@/lib/points";
import { emitDataInvalidation, subscribeToDataInvalidation } from "@/lib/clientEvents";
import {
  buildProfileCompletionMessage,
  claimProfileCompletionReward,
  dismissProfileCompletion,
  fetchProfileCompletion,
  recordProfileCompletionImpression,
  type ProfileCompletionGuide as ProfileCompletionGuideState,
  type ProfileCompletionStepKey,
} from "@/lib/profileCompletion";
import {
  buildReferralLink,
  clearPendingReferralCode,
  getPendingReferralCode,
  isTerminalReferralError,
  normalizeReferralCode,
  storePendingReferralCode,
} from "@/lib/referrals";
import { BASE_CHAIN_ID, USDC_ADDRESS } from "@/lib/tokens";
import { DATA_SUFFIX } from "@/lib/builderCode";
import {
  buildBasePaymasterCapabilities,
  isPaymasterEnabled,
  isUserRejectedRequest,
} from "@/lib/paymaster";
import {
  fetchProfileSettings,
  resolveProfileDisplay,
  type ProfileSettingsResponse,
} from "@/lib/profileSettings";
import { ensureSiweSession } from "@/lib/siweAuth";

type NeynarProfile = {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string;
};

type ToastState =
  | {
      kind: "success" | "error";
      message: string;
    }
  | null;

type CelebrationState =
  | {
      kind: "checkin" | "save";
      id: number;
    }
  | null;

type FlowStage = "idle" | "wallet" | "verifying";
type FeeConfig = NonNullable<PointsBalance["checkInConfig"]>;

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error ?? "Unknown error");
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getXConnectErrorMessage(error?: string | null) {
  if (!error) {
    return "X connection failed. Please try again.";
  }

  if (error.toLowerCase().includes("already linked")) {
    return error;
  }

  return "X connection failed. Please try again.";
}

function getDiscordConnectErrorMessage(error?: string | null) {
  if (!error) {
    return "Discord connection failed. Please try again.";
  }

  if (error === "DISCORD_OAUTH_STATE_INVALID") {
    return "Discord connection expired. Please try again.";
  }

  if (error === "DISCORD_NOT_CONFIGURED") {
    return "Discord is not configured on the API server.";
  }

  return "Discord connection failed. Please try again.";
}

function isTxHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function toHexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`;
}

function resolveSendCallsId(result: unknown) {
  if (typeof result === "string" && result.trim()) {
    return result;
  }

  if (result && typeof result === "object" && "id" in result) {
    const value = (result as { id?: unknown }).id;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  if (result && typeof result === "object" && "batchId" in result) {
    const value = (result as { batchId?: unknown }).batchId;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function formatNumber(value: number) {
  return value.toLocaleString();
}

function MiniMetric({
  label,
  value,
  accent,
  isLoading,
}: {
  label: string;
  value: string;
  accent: "sky" | "amber" | "emerald";
  isLoading?: boolean;
}) {
  const accents = {
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };

  return (
    <div className={`rounded-[20px] border px-3 py-3 ${accents[accent]}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.22em] opacity-70">
        {label}
      </p>
      <p className="mt-1.5 text-lg font-black tracking-tight">
        {isLoading ? <span className="animate-pulse opacity-50">...</span> : value}
      </p>
    </div>
  );
}

const PROFILE_FAQ_ITEMS = [
  {
    question: "What is DustSwap?",
    answers: [
      "DustSwap is a DEX and bridge built on Base, supporting 20+ networks.",
      "DustSwap also lets users sweep multiple dust tokens into ETH in a single transaction. This feature is currently under development.",
    ],
  },
  {
    question: "What is Check-In, and why should I do it?",
    answers: [
      "Check-In is DustSwap's daily attendance system for users.",
      "By checking in, you earn 100 base PP and a 10% daily boost.",
      "Your points grow faster as your Check-In boost increases.",
      "You can unlock up to a 300% boost on eligible PP.",
    ],
  },
  {
    question: "What are Quests, and why should I complete them?",
    answers: [
      "Quests are social and onchain tasks for DustSwap users.",
      "By completing quests, you earn PP.",
      "PP will convert into $DUST tokens after TGE.",
      "Your PP helps measure your contribution to DustSwap and may help determine your allocation.",
    ],
  },
] as const;

function ProfilePageContent() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { data: walletClient } = useWalletClient();
  const { disconnectWallet, supportsBaseAccountFeatures } = useWalletConnection();
  const { isOnBase, isSwitching: isSwitchingToBase, switchToBase } = useBaseChainSwitch();
  const publicClient = usePublicClient();

  const [isMounted, setIsMounted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<NeynarProfile | null>(null);
  const [profileSettings, setProfileSettings] =
    useState<ProfileSettingsResponse | null>(null);
  const [isProfileSettingsLoading, setIsProfileSettingsLoading] = useState(false);
  const [profileSettingsError, setProfileSettingsError] = useState<string | null>(null);
  const [profileCompletion, setProfileCompletion] =
    useState<ProfileCompletionGuideState | null>(null);
  const [isProfileCompletionLoading, setIsProfileCompletionLoading] =
    useState(false);
  const [isProfileCompletionModalOpen, setIsProfileCompletionModalOpen] =
    useState(false);
  const [isClaimingProfileCompletionReward, setIsClaimingProfileCompletionReward] =
    useState(false);
  const [balance, setBalance] = useState<PointsBalance | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [referral, setReferral] = useState<ReferralStats | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [celebration, setCelebration] = useState<CelebrationState>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<ProfileSettingsInitialSection>("profile");
  const [settingsInitialFocusTarget, setSettingsInitialFocusTarget] =
    useState<ProfileSettingsFocusTarget | null>(null);
  const [settingsConnectionSource, setSettingsConnectionSource] =
    useState<string | null>(null);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isDisconnectingProfile, setIsDisconnectingProfile] = useState(false);
  const [pendingReferralCode, setPendingReferralCode] = useState<string | null>(null);

  // Inline referral code entry state — profile fallback, completely separate from link-based flow
  type InlineValidation =
    | { status: "idle" }
    | { status: "validating" }
    | { status: "valid"; message: string }
    | { status: "invalid"; message: string };
  const [inlineCode, setInlineCode] = useState("");
  const [isApplyingInline, setIsApplyingInline] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineInfo, setInlineInfo] = useState<string | null>(null);
  const [inlineSuccess, setInlineSuccess] = useState(false);
  const [inlineValidation, setInlineValidation] = useState<InlineValidation>({ status: "idle" });
  const inlineDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silentRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const lastSilentRefreshAtRef = useRef(0);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const referralSectionRef = useRef<HTMLElement | null>(null);
  const trackerImpressionAddressRef = useRef<string | null>(null);
  const modalImpressionAddressRef = useRef<string | null>(null);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [checkInStage, setCheckInStage] = useState<FlowStage>("idle");
  const [recoveryStage, setRecoveryStage] = useState<FlowStage>("idle");

  const { data: usdcBalanceRaw } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    query: {
      enabled: !!address,
    },
  });

  const usdcBalance = (usdcBalanceRaw as bigint | undefined) ?? 0n;

  const preferredCheckInAsset = useMemo<"eth" | "usdc">(() => {
    if (!balance) {
      return "eth";
    }

    const requiredUsdc = BigInt(balance.checkInConfig.usdcAmountUnits);
    return requiredUsdc > 0n && usdcBalance >= requiredUsdc ? "usdc" : "eth";
  }, [balance, usdcBalance]);

  const preferredSaveAsset = useMemo<"eth" | "usdc">(() => {
    if (!balance) {
      return "eth";
    }

    const requiredUsdc = BigInt(balance.saveConfig.usdcAmountUnits);
    return requiredUsdc > 0n && usdcBalance >= requiredUsdc ? "usdc" : "eth";
  }, [balance, usdcBalance]);

  const usesBasePayForCheckIn =
    supportsBaseAccountFeatures && preferredCheckInAsset === "usdc";
  const usesBasePayForSave = supportsBaseAccountFeatures && preferredSaveAsset === "usdc";
  const referralLink = useMemo(
    () => (referral?.code ? buildReferralLink(referral.code) : ""),
    [referral?.code]
  );
  const hasCompletedFirstCheckIn = Boolean(balance?.lastCheckIn);
  const profileDisplay = useMemo(
    () =>
      resolveProfileDisplay({
        settings: profileSettings,
        neynarProfile: profile,
        address,
      }),
    [address, profile, profileSettings]
  );
  const shouldShowProfileCompletionGuide = useMemo(() => {
    if (!profileCompletion) {
      return false;
    }

    return !(
      profileCompletion.rewardClaimed &&
      profileCompletion.completedSteps >= profileCompletion.totalSteps
    );
  }, [profileCompletion]);

  const applySummary = useCallback((summary: PointsSummaryResponse) => {
    setBalance(summary.balance);
    setStats(summary.stats);
    setReferral(summary.referral);
  }, []);

  // Establish a SIWE bearer session (one signature) so the API will return this
  // wallet's own private data. Best-effort: if the user rejects, protected
  // sections stay empty but the page does not break.
  const ensureProfileSession = useCallback(async () => {
    if (!address) {
      return false;
    }

    try {
      await ensureSiweSession({
        address,
        chainId: BASE_CHAIN_ID,
        signMessage: ({ message }) => signMessageAsync({ message }) as Promise<Hex>,
        statement: "Sign in to DustSwap to view your profile.",
      });
      return true;
    } catch {
      return false;
    }
  }, [address, signMessageAsync]);

  const fetchProfileData = useCallback(
    async (options?: { force?: boolean; silent?: boolean }) => {
      if (!address) {
        setBalance(null);
        setStats(null);
        setReferral(null);
        setProfile(null);
        setProfileSettings(null);
        setIsLoading(false);
        return;
      }

      if (!options?.silent) {
        setIsLoading(true);
      }

      try {
        const summary = await fetchPointsSummary(address, {
          force: options?.force,
        });

        if (!summary.success) {
          throw new Error(summary.error || "Failed to load profile summary");
        }

        applySummary(summary);
      } catch (error) {
        setToast({
          kind: "error",
          message: (error as Error).message || "Failed to load your profile",
        });
      } finally {
        if (!options?.silent) {
          setIsLoading(false);
        }
      }
    },
    [address, applySummary]
  );

  const refreshProfileDataSilently = useCallback(() => {
    if (!address) {
      return Promise.resolve();
    }

    if (silentRefreshPromiseRef.current) {
      return silentRefreshPromiseRef.current;
    }

    const now = Date.now();
    if (now - lastSilentRefreshAtRef.current < 250) {
      return Promise.resolve();
    }

    lastSilentRefreshAtRef.current = now;

    const request = fetchProfileData({ force: true, silent: true }).finally(() => {
      if (silentRefreshPromiseRef.current === request) {
        silentRefreshPromiseRef.current = null;
      }
    });

    silentRefreshPromiseRef.current = request;
    return request;
  }, [address, fetchProfileData]);

  const fetchNeynarProfile = useCallback(async () => {
    if (!address) {
      setProfile(null);
      return;
    }

    try {
      const response = await fetch(`/api/neynar/user?address=${address}`, {
        cache: "no-store",
      });
      const data = response.ok ? await response.json() : null;

      if (data && !data.error) {
        setProfile(data);
        return;
      }

      setProfile(null);
    } catch {
      setProfile(null);
    }
  }, [address]);

  const fetchProfileSettingsData = useCallback(async () => {
    if (!address) {
      setProfileSettings(null);
      setProfileSettingsError(null);
      setIsProfileSettingsLoading(false);
      return;
    }

    setIsProfileSettingsLoading(true);
    try {
      const nextSettings = await fetchProfileSettings(address);
      setProfileSettings(nextSettings);
      setProfileSettingsError(null);
    } catch (error) {
      setProfileSettings(null);
      setProfileSettingsError(
        error instanceof Error ? error.message : "Failed to load profile settings"
      );
    } finally {
      setIsProfileSettingsLoading(false);
    }
  }, [address]);

  const fetchProfileCompletionData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!address) {
        setProfileCompletion(null);
        setIsProfileCompletionLoading(false);
        return;
      }

      if (!options?.silent) {
        setIsProfileCompletionLoading(true);
      }

      try {
        const nextGuide = await fetchProfileCompletion(address);
        setProfileCompletion(nextGuide.guide);
      } catch {
        // Keep the rest of the profile resilient if the completion API is unavailable.
      } finally {
        if (!options?.silent) {
          setIsProfileCompletionLoading(false);
        }
      }
    },
    [address]
  );

  const openProfileSettings = useCallback(
    (options?: {
      section?: ProfileSettingsInitialSection;
      focusTarget?: ProfileSettingsFocusTarget | null;
      source?: string | null;
    }) => {
      setSettingsInitialSection(options?.section ?? "profile");
      setSettingsInitialFocusTarget(options?.focusTarget ?? null);
      setSettingsConnectionSource(options?.source ?? null);
      setIsSettingsOpen(true);

      if (!profileSettings && !isProfileSettingsLoading) {
        void fetchProfileSettingsData();
      }
    },
    [
      fetchProfileSettingsData,
      isProfileSettingsLoading,
      profileSettings,
    ]
  );

  const openWalletLinking = useCallback(() => {
    openProfileSettings({
      section: "connections",
      focusTarget: "wallet_linking",
      source: "wallet_link_promo",
    });
  }, [openProfileSettings]);

  const closeProfileSettings = useCallback(() => {
    setIsSettingsOpen(false);
    setSettingsInitialSection("profile");
    setSettingsInitialFocusTarget(null);
    setSettingsConnectionSource(null);
    void fetchProfileCompletionData({ silent: true });
  }, [fetchProfileCompletionData]);

  const handleProfileDisconnect = useCallback(async () => {
    if (isDisconnectingProfile) {
      return;
    }

    setIsDisconnectingProfile(true);
    try {
      await disconnectWallet();
      setIsProfileMenuOpen(false);
    } catch (error) {
      console.error("Profile disconnect failed", error);
      setToast({
        kind: "error",
        message: "Could not disconnect wallet. Please try again.",
      });
    } finally {
      setIsDisconnectingProfile(false);
    }
  }, [disconnectWallet, isDisconnectingProfile]);

  useEffect(() => {
    setIsMounted(true);
    if (typeof window === "undefined") {
      return;
    }

    const rawReferralCode = new URLSearchParams(window.location.search).get("ref");
    const normalizedReferralCode = rawReferralCode
      ? normalizeReferralCode(rawReferralCode)
      : null;

    if (normalizedReferralCode) {
      storePendingReferralCode(normalizedReferralCode);
      setPendingReferralCode(normalizedReferralCode);
      return;
    }

    setPendingReferralCode(getPendingReferralCode());
  }, []);

  useEffect(() => {
    if (isConnected) {
      void fetchProfileData();
      void fetchNeynarProfile();
      void fetchProfileSettingsData();
      void fetchProfileCompletionData();
      return;
    }

    setBalance(null);
    setStats(null);
    setReferral(null);
    setProfile(null);
    setProfileSettings(null);
    setProfileSettingsError(null);
    setIsProfileSettingsLoading(false);
    setProfileCompletion(null);
    setIsProfileCompletionLoading(false);
    setIsProfileCompletionModalOpen(false);
    setSettingsInitialSection("profile");
    setSettingsInitialFocusTarget(null);
    setSettingsConnectionSource(null);
    setIsSettingsOpen(false);
    setIsProfileMenuOpen(false);
    setIsDisconnectingProfile(false);
    setIsLoading(false);
  }, [
    fetchNeynarProfile,
    fetchProfileCompletionData,
    fetchProfileData,
    fetchProfileSettingsData,
    isConnected,
  ]);

  useEffect(() => {
    if (!isProfileMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setIsProfileMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsProfileMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isProfileMenuOpen]);

  useEffect(() => {
    if (
      !isSettingsOpen ||
      !address ||
      profileSettings ||
      profileSettingsError ||
      isProfileSettingsLoading
    ) {
      return;
    }

    void fetchProfileSettingsData();
  }, [
    address,
    fetchProfileSettingsData,
    isProfileSettingsLoading,
    isSettingsOpen,
    profileSettings,
    profileSettingsError,
  ]);

  // Opening the settings modal is where private social details are managed, so
  // sign in on demand (one signature, cached) and reload the full owner payload.
  // The profile page itself loads with no prompt (it only needs public display).
  useEffect(() => {
    if (!isSettingsOpen || !address) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const signedIn = await ensureProfileSession();
      if (signedIn && !cancelled) {
        await fetchProfileSettingsData();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSettingsOpen, address, ensureProfileSession, fetchProfileSettingsData]);

  useEffect(() => {
    silentRefreshPromiseRef.current = null;
    lastSilentRefreshAtRef.current = 0;
  }, [address]);

  useEffect(() => {
    trackerImpressionAddressRef.current = null;
    modalImpressionAddressRef.current = null;
  }, [address]);

  useEffect(() => {
    if (!address || typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const openSettingsParam = params.get("open_settings");
    const settingsSectionParam = params.get("settings_section");
    const settingsFocusParam = params.get("settings_focus");
    const settingsSourceParam = params.get("settings_source");
    const xLinked = params.get("x_linked");
    const xError = params.get("x_error");
    const xUsername = params.get("x_username");
    const discordLinked = params.get("discord_linked");
    const discordError = params.get("discord_error");
    const discordUsername = params.get("discord_username");

    if (
      !openSettingsParam &&
      !xLinked &&
      !xError &&
      !discordLinked &&
      !discordError
    ) {
      return;
    }

    const settingsFocusTarget =
      settingsFocusParam === "x_connection" ||
      settingsFocusParam === "discord_connection"
        ? settingsFocusParam
        : null;
    const settingsSection =
      settingsSectionParam === "connections" ? "connections" : "profile";

    if (openSettingsParam === "1") {
      openProfileSettings({
        section: settingsSection,
        focusTarget: settingsFocusTarget,
        source: settingsSourceParam || null,
      });
    }

    if (xLinked === "1") {
      setToast({
        kind: "success",
        message: xUsername ? `X connected as @${xUsername}.` : "X connected.",
      });
      emitDataInvalidation(["profile", "quests"], "x-connected");
      void refreshProfileDataSilently();
      void fetchProfileSettingsData();
      void fetchProfileCompletionData({ silent: true });
    } else if (xError) {
      setToast({
        kind: "error",
        message: getXConnectErrorMessage(xError),
      });
    }

    if (discordLinked === "1") {
      setToast({
        kind: "success",
        message: discordUsername
          ? `Discord connected as ${discordUsername}.`
          : "Discord connected.",
      });
      emitDataInvalidation(["profile", "quests"], "discord-connected");
      void refreshProfileDataSilently();
      void fetchProfileSettingsData();
      void fetchProfileCompletionData({ silent: true });
    } else if (discordError) {
      setToast({
        kind: "error",
        message: getDiscordConnectErrorMessage(discordError),
      });
    }

    [
      "open_settings",
      "settings_section",
      "settings_focus",
      "settings_source",
      "x_linked",
      "x_error",
      "x_username",
      "discord_linked",
      "discord_error",
      "discord_username",
    ].forEach((key) => params.delete(key));

    const nextUrl = `${window.location.pathname}${
      params.toString() ? `?${params.toString()}` : ""
    }${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [
    address,
    fetchProfileCompletionData,
    fetchProfileSettingsData,
    openProfileSettings,
    refreshProfileDataSilently,
  ]);

  useEffect(() => {
    if (!address) {
      return;
    }

    const handleFocus = () => {
      void refreshProfileDataSilently();
      void fetchProfileCompletionData({ silent: true });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshProfileDataSilently();
        void fetchProfileCompletionData({ silent: true });
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [address, fetchProfileCompletionData, refreshProfileDataSilently]);

  useEffect(() => {
    if (!address) {
      return;
    }

    const handleInvalidation = () => {
      void refreshProfileDataSilently();
      void fetchProfileSettingsData();
      void fetchProfileCompletionData({ silent: true });
    };
    const unsubscribeProfile = subscribeToDataInvalidation("profile", handleInvalidation);
    const unsubscribePoints = subscribeToDataInvalidation("points", handleInvalidation);

    return () => {
      unsubscribeProfile();
      unsubscribePoints();
    };
  }, [
    address,
    fetchProfileCompletionData,
    fetchProfileSettingsData,
    refreshProfileDataSilently,
  ]);

  useEffect(() => {
    if (!pendingReferralCode || referral?.hasReferrer !== true) {
      return;
    }

    clearPendingReferralCode();
    setPendingReferralCode(null);
    setInlineInfo(null);
  }, [pendingReferralCode, referral?.hasReferrer]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4200);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!address || !profileCompletion || !shouldShowProfileCompletionGuide) {
      return;
    }

    if (trackerImpressionAddressRef.current === address.toLowerCase()) {
      return;
    }

    trackerImpressionAddressRef.current = address.toLowerCase();
    void recordProfileCompletionImpression({
      address,
      surface: "tracker",
    });
  }, [address, profileCompletion, shouldShowProfileCompletionGuide]);

  useEffect(() => {
    if (!shouldShowProfileCompletionGuide) {
      setIsProfileCompletionModalOpen(false);
      return;
    }

    if (!address || !profileCompletion?.showModal) {
      return;
    }

    setIsProfileCompletionModalOpen(true);

    if (modalImpressionAddressRef.current === address.toLowerCase()) {
      return;
    }

    modalImpressionAddressRef.current = address.toLowerCase();
    void recordProfileCompletionImpression({
      address,
      surface: "modal",
    });
  }, [address, profileCompletion?.showModal, shouldShowProfileCompletionGuide]);

  useEffect(() => {
    if (!celebration) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCelebration(null);
    }, 2200);

    return () => window.clearTimeout(timeout);
  }, [celebration]);

  const updateBalanceAndStats = useCallback((nextBalance: PointsBalance) => {
    setBalance(nextBalance);
    setStats((current) =>
      current
        ? {
            ...current,
            totalPoints: nextBalance.totalPoints,
          }
        : current
    );
  }, []);

  // Debounced preview for inline profile code entry
  useEffect(() => {
    if (inlineDebounceRef.current) clearTimeout(inlineDebounceRef.current);
    const trimmed = inlineCode.trim();
    if (!trimmed || trimmed.length < 4 || !address) {
      setInlineValidation({ status: "idle" });
      return;
    }
    setInlineValidation({ status: "validating" });
    inlineDebounceRef.current = setTimeout(async () => {
      try {
        const res = await previewReferralCode(address, trimmed);
        setInlineValidation(
          res.valid
            ? { status: "valid", message: res.message || "Valid code!" }
            : { status: "invalid", message: res.message || "Invalid code." }
        );
      } catch {
        setInlineValidation({ status: "idle" });
      }
    }, 600);
    return () => { if (inlineDebounceRef.current) clearTimeout(inlineDebounceRef.current); };
  }, [address, inlineCode]);

  const handleApplyInline = useCallback(async () => {
    const trimmed = inlineCode.trim();
    if (!trimmed || isApplyingInline || !address) return;
    setIsApplyingInline(true);
    setInlineError(null);
    setInlineInfo(null);
    try {
      const normalizedCode = trimmed.toUpperCase();
      const result = await applyReferralCode(address, normalizedCode);
      if (!result.success) {
        if (result.deferred) {
          storePendingReferralCode(normalizedCode);
          setPendingReferralCode(normalizedCode);
          setInlineCode("");
          setInlineInfo(
            "Invite code saved. It will activate after your first onchain check-in or PP claim."
          );
          setToast({
            kind: "success",
            message:
              "Invite code saved. It will activate after your first onchain check-in or PP claim.",
          });
          return;
        }

        setInlineError(result.error || "Could not apply code. Please try again.");
        return;
      }
      setInlineSuccess(true);
      setInlineCode("");
      setInlineInfo(null);
      clearPendingReferralCode();
      setPendingReferralCode(null);
      clearPointsSummaryCache(address);
      emitDataInvalidation(["leaderboard", "points"], "referral-applied");
      setToast({ kind: "success", message: "Referral linked! +500 PP on the way." });
      await refreshProfileDataSilently();
      await fetchProfileCompletionData({ silent: true });
    } catch {
      setInlineError("Something went wrong. Please try again.");
    } finally {
      setIsApplyingInline(false);
    }
  }, [
    address,
    fetchProfileCompletionData,
    inlineCode,
    isApplyingInline,
    refreshProfileDataSilently,
  ]);

  const promptSwitchToBase = useCallback(async (successMessage: string) => {
    try {
      const switched = await switchToBase();

      if (switched) {
        setToast({
          kind: "success",
          message: successMessage,
        });
      }

      return switched;
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error) || "Please switch your wallet to Base to continue.",
      });
      return false;
    }
  }, [switchToBase]);

  const sendFeeTransaction = useCallback(
    async (config: FeeConfig, asset: "eth" | "usdc") => {
      if (!walletClient || !publicClient) {
        throw new Error("Wallet is not ready");
      }

      if (!isOnBase) {
        throw new Error("Switch your wallet to Base before sending this check-in transaction");
      }

      const targetAddress =
        asset === "usdc"
          ? (config.usdcAddress as `0x${string}`)
          : (config.recipient as `0x${string}`);
      const txData =
        asset === "usdc"
          ? encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [config.recipient as `0x${string}`, BigInt(config.usdcAmountUnits)],
            })
          : undefined;
      const txValue = asset === "usdc" ? 0n : BigInt(config.ethAmountWei);
      const requestClient = walletClient as typeof walletClient & {
        account?: { address?: `0x${string}` };
        request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      };

      if (isPaymasterEnabled() && supportsBaseAccountFeatures) {
        try {
          const capabilitiesResult =
            requestClient.account?.address
              ? ((await requestClient.request({
                  method: "wallet_getCapabilities",
                  params: [requestClient.account.address],
                })) as Record<
                  string,
                  {
                    paymasterService?: {
                      supported?: boolean;
                    };
                  }
                > | null)
              : null;
          const chainCapabilities = capabilitiesResult
            ? Object.entries(capabilitiesResult).find(
                ([candidate]) => candidate.toLowerCase() === toHexChainId(BASE_CHAIN_ID).toLowerCase()
              )?.[1]
            : null;

          if (!chainCapabilities?.paymasterService?.supported) {
            throw new Error("wallet paymasterService capability is unavailable");
          }

          const sendCallsResult = await walletClient.sendCalls({
            calls: [
              {
                to: targetAddress,
                data: txData,
                value: txValue,
                dataSuffix: DATA_SUFFIX,
              },
            ],
            capabilities: buildBasePaymasterCapabilities(),
          } as any);

          const callId = resolveSendCallsId(sendCallsResult);
          if (!callId) {
            throw new Error("wallet_sendCalls did not return an id");
          }

          const status = await walletClient.waitForCallsStatus({
            id: callId,
            throwOnFailure: true,
            timeout: 120_000,
          });
          const hash = status.receipts?.find((receipt) => isTxHash(receipt?.transactionHash))
            ?.transactionHash;

          if (!hash) {
            throw new Error("Sponsored transaction finished without a transaction hash");
          }

          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            throw new Error("Transaction reverted");
          }

          return hash;
        } catch (error) {
          if (isUserRejectedRequest(error)) {
            throw error;
          }

          console.warn("Paymaster sendCalls failed for check-in, falling back to direct sendTransaction.", error);
        }
      }

      const hash = await walletClient.sendTransaction({
        to: targetAddress,
        data: txData,
        dataSuffix: DATA_SUFFIX,
        value: txValue,
      } as any);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("Transaction reverted");
      }

      return hash;
    },
    [isOnBase, publicClient, supportsBaseAccountFeatures, walletClient]
  );

  const sendBasePayTransaction = useCallback(async (config: FeeConfig) => {
    const payment = await pay({
      amount: config.usdcAmount,
      to: config.recipient,
      testnet: false,
      telemetry: false,
    });

    if (!payment?.id) {
      throw new Error("Base Pay did not return a payment id");
    }

    return payment.id as `0x${string}`;
  }, []);

  const sendCheckInPayment = useCallback(
    async (config: FeeConfig) => {
      if (usesBasePayForCheckIn) {
        return {
          hash: await sendBasePayTransaction(config),
          asset: "usdc" as const,
        };
      }

      return {
        hash: await sendFeeTransaction(config, preferredCheckInAsset),
        asset: preferredCheckInAsset,
      };
    },
    [
      preferredCheckInAsset,
      sendBasePayTransaction,
      sendFeeTransaction,
      usesBasePayForCheckIn,
    ]
  );

  const sendSavePayment = useCallback(
    async (config: FeeConfig) => {
      if (usesBasePayForSave) {
        return {
          hash: await sendBasePayTransaction(config),
          asset: "usdc" as const,
        };
      }

      return {
        hash: await sendFeeTransaction(config, preferredSaveAsset),
        asset: preferredSaveAsset,
      };
    },
    [preferredSaveAsset, sendBasePayTransaction, sendFeeTransaction, usesBasePayForSave]
  );

  const handleCheckIn = useCallback(async () => {
    if (!address || !balance) {
      setToast({ kind: "error", message: "Connect your wallet first." });
      return;
    }

    if (isSwitchingToBase) {
      return;
    }

    if (!isOnBase) {
      await promptSwitchToBase("Wallet switched to Base. Tap check-in again to continue.");
      return;
    }

    setIsCheckingIn(true);
    setCheckInStage("wallet");

    try {
      const { asset, hash } = await sendCheckInPayment(balance.checkInConfig);
      setCheckInStage("verifying");

      const result = await performDailyCheckIn({
        address,
        txHash: hash,
        asset,
      });

      if (!result.success) {
        throw new Error(result.error || "Onchain check-in failed");
      }

      const baseSuccessMessage =
        balance.checkInConfig.usdTarget <= 0
          ? "Onchain check-in complete."
          : asset === "usdc"
            ? `Onchain check-in complete with ${balance.checkInConfig.usdcAmount} USDC.`
            : `Onchain check-in complete with $${balance.checkInConfig.usdTarget.toFixed(2)} in ETH.`;

      updateBalanceAndStats(result);
      clearPointsSummaryCache(address);
      setCelebration({ kind: "checkin", id: Date.now() });
      emitDataInvalidation(["leaderboard", "points"], "check-in");

      let successMessage = baseSuccessMessage;

      if (pendingReferralCode && referral?.hasReferrer !== true) {
        try {
          const referralResult = await applyReferralCode(address, pendingReferralCode);

          if (referralResult.success) {
            clearPendingReferralCode();
            setPendingReferralCode(null);
            setInlineInfo(null);
            clearPointsSummaryCache(address);
            emitDataInvalidation(["leaderboard", "points"], "referral-applied");
            await refreshProfileDataSilently();
            successMessage = `${baseSuccessMessage} Invite code activated.`;
          } else if (referralResult.deferred) {
            storePendingReferralCode(pendingReferralCode);
            setPendingReferralCode(pendingReferralCode);
          } else if (isTerminalReferralError(referralResult.error || referralResult.message)) {
            clearPendingReferralCode();
            setPendingReferralCode(null);
            setInlineInfo(null);
            if ((referralResult.error || referralResult.message || "").toLowerCase().includes("already referred")) {
              clearPointsSummaryCache(address);
              await refreshProfileDataSilently();
            }
          }
        } catch (referralError) {
          console.error("Referral activation after check-in failed", referralError);
        }
      }

      setToast({
        kind: "success",
        message: successMessage,
      });
    } catch (error) {
      console.error(error);
      setToast({
        kind: "error",
        message:
          getErrorMessage(error) ||
          (usesBasePayForCheckIn
            ? "Base Pay check-in failed. Try again."
            : "Check-in transaction failed. Try again."),
      });
    } finally {
      setCheckInStage("idle");
      setIsCheckingIn(false);
    }
  }, [
    address,
    balance,
    isOnBase,
    isSwitchingToBase,
    pendingReferralCode,
    promptSwitchToBase,
    referral?.hasReferrer,
    refreshProfileDataSilently,
    sendCheckInPayment,
    updateBalanceAndStats,
    usesBasePayForCheckIn,
  ]);

  const handleReset = useCallback(async () => {
    if (!address) {
      setToast({ kind: "error", message: "Connect your wallet first." });
      return;
    }

    setIsResetting(true);

    try {
      const result = await resetBrokenStreak(address);
      if (!result.success) {
        throw new Error(result.error || "Reset failed");
      }

      updateBalanceAndStats(result);
      clearPointsSummaryCache(address);
      setToast({
        kind: "success",
        message: result.reset
          ? "Streak reset. You can start again today."
          : "There was no broken streak to reset.",
      });
      emitDataInvalidation("points", "reset-streak");
    } catch (error) {
      setToast({
        kind: "error",
        message: (error as Error).message || "Reset failed",
      });
    } finally {
      setIsResetting(false);
    }
  }, [address, updateBalanceAndStats]);

  const handleSave = useCallback(async () => {
    if (!address || !balance) {
      setToast({
        kind: "error",
        message: "Connect your wallet to save this streak.",
      });
      return;
    }

    if (!balance.streakRecoveryEnabled) {
      setToast({
        kind: "error",
        message: "Streak recovery is currently disabled.",
      });
      return;
    }

    if (isSwitchingToBase) {
      return;
    }

    if (!isOnBase) {
      await promptSwitchToBase("Wallet switched to Base. Tap save again to continue.");
      return;
    }

    setIsSaving(true);
    setRecoveryStage("wallet");

    try {
      const { asset, hash } = await sendSavePayment(balance.saveConfig);
      setRecoveryStage("verifying");

      const result = await saveBrokenStreak({
        address,
        txHash: hash,
        asset,
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to restore streak");
      }

      updateBalanceAndStats(result);
      clearPointsSummaryCache(address);
      setCelebration({ kind: "save", id: Date.now() });
      setToast({
        kind: "success",
        message: "Streak Saved!",
      });
      emitDataInvalidation(["leaderboard", "points"], "save-streak");
    } catch (error) {
      console.error(error);
      const message = getErrorMessage(error);
      setToast({
        kind: "error",
        message: message || "Transaction failed. Try again to save your streak.",
      });
    } finally {
      setRecoveryStage("idle");
      setIsSaving(false);
    }
  }, [
    address,
    balance,
    isOnBase,
    isSwitchingToBase,
    promptSwitchToBase,
    sendSavePayment,
    updateBalanceAndStats,
  ]);

  const handleDismissProfileCompletionModal = useCallback(() => {
    setIsProfileCompletionModalOpen(false);

    if (!address) {
      return;
    }

    setProfileCompletion((current) =>
      current
        ? {
            ...current,
            showModal: false,
          }
        : current
    );

    void dismissProfileCompletion(address);
  }, [address]);

  const handleClaimProfileCompletionReward = useCallback(async () => {
    if (
      !address ||
      !profileCompletion?.canClaimReward ||
      isClaimingProfileCompletionReward
    ) {
      return;
    }

    setIsClaimingProfileCompletionReward(true);

    try {
      const message = buildProfileCompletionMessage(address);
      const signature = (await signMessageAsync({
        message,
      })) as Hex;
      const result = await claimProfileCompletionReward({
        address,
        message,
        signature,
      });

      clearPointsSummaryCache(address);
      setProfileCompletion(result.guide);
      setIsProfileCompletionModalOpen(false);
      emitDataInvalidation(["leaderboard", "points", "profile"], "profile-completion-claimed");
      await Promise.all([
        refreshProfileDataSilently(),
        fetchProfileSettingsData(),
        fetchProfileCompletionData({ silent: true }),
      ]);
      setToast({
        kind: "success",
        message: "1,000 PP claimed.",
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const payload = (error as Error & {
        payload?: { guide?: ProfileCompletionGuideState };
      }).payload;

      if (payload?.guide) {
        setProfileCompletion(payload.guide);
      }

      setToast({
        kind: "error",
        message: message || "Failed to claim your profile completion reward.",
      });
    } finally {
      setIsClaimingProfileCompletionReward(false);
    }
  }, [
    address,
    fetchProfileCompletionData,
    fetchProfileSettingsData,
    isClaimingProfileCompletionReward,
    profileCompletion?.canClaimReward,
    refreshProfileDataSilently,
    signMessageAsync,
  ]);

  const handleProfileCompletionContinue = useCallback(
    async (step: ProfileCompletionStepKey | "claim_reward") => {
      if (step === "claim_reward") {
        await handleClaimProfileCompletionReward();
        return;
      }

      setIsProfileCompletionModalOpen(false);

      if (step === "add_referral") {
        referralSectionRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        return;
      }

      openProfileSettings({
        section: "connections",
        focusTarget:
          step === "connect_x" ? "x_connection" : "discord_connection",
        source: "profile_completion",
      });
    },
    [handleClaimProfileCompletionReward, openProfileSettings]
  );

  const handleProfileSettingsSaved = useCallback(
    (settings: ProfileSettingsResponse) => {
      setProfileSettings(settings);
      setProfileSettingsError(null);
      setIsSettingsOpen(false);
      setSettingsInitialSection("profile");
      setSettingsInitialFocusTarget(null);
      setSettingsConnectionSource(null);
      setToast({
        kind: "success",
        message: "Profile updated.",
      });
      void fetchProfileCompletionData({ silent: true });
      emitDataInvalidation(
        ["profile", "leaderboard", "quests"],
        "profile-settings-updated"
      );
    },
    [fetchProfileCompletionData]
  );

  if (!isMounted) {
    return null;
  }

  if (!isConnected) {
    return (
      <div
        className="theme-page relative overflow-hidden"
        style={{ minHeight: "calc(100dvh - 4rem)" }}
      >

        {/* ── Layer 1: Blurred fake profile background ── */}
        <div
          aria-hidden="true"
          className="pointer-events-none select-none bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_22%),linear-gradient(180deg,#f8fafc,#fef7ed_45%,#eff6ff)] px-3 py-4 pb-16 sm:px-6 sm:py-8 blur-sm opacity-60"
          style={{ minHeight: "calc(100dvh - 4rem)" }}
        >
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 sm:gap-5 xl:max-w-5xl 2xl:max-w-6xl">

            {/* Profile card skeleton */}
            <div className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur sm:px-5 sm:py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-sky-200 bg-[linear-gradient(135deg,#38bdf8,#0ea5e9)] text-base font-black text-white shadow-[0_10px_28px_rgba(14,165,233,0.22)]">
                  0x
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[9px] font-black uppercase tracking-[0.32em] text-slate-500">Profile Hub</p>
                  <div className="mt-1 h-5 w-32 rounded-full bg-slate-200" />
                  <div className="mt-1 h-3 w-20 rounded-full bg-slate-100" />
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
                {(["sky", "amber", "sky", "emerald"] as const).map((accent, i) => {
                  const cls = {
                    sky: "border-sky-200 bg-sky-50",
                    amber: "border-amber-200 bg-amber-50",
                    emerald: "border-emerald-200 bg-emerald-50",
                  }[accent];
                  const labels = ["Total PP", "Rank", "All-Time Volume", "Total Referrals"];
                  return (
                    <div key={i} className={`rounded-[20px] border px-3 py-3 ${cls}`}>
                      <p className="text-[10px] font-black uppercase tracking-[0.22em] opacity-70">{labels[i]}</p>
                      <div className="mt-1.5 h-6 w-14 rounded-full bg-slate-200/80" />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Daily Check-In skeleton */}
            <div className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-4 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-5">
              <div className="h-2.5 w-24 rounded-full bg-slate-200" />
              <div className="mt-2 h-6 w-36 rounded-full bg-slate-200" />
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="h-14 rounded-[18px] bg-sky-50 border border-sky-100" />
                <div className="h-14 rounded-[18px] bg-amber-50 border border-amber-100" />
                <div className="h-14 rounded-[18px] bg-emerald-50 border border-emerald-100" />
              </div>
              <div className="mt-3 h-11 w-full rounded-[20px] bg-slate-100" />
            </div>

            {/* Referral Vault skeleton */}
            <div className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="h-2 w-16 rounded-full bg-slate-200" />
                  <div className="mt-1.5 h-4 w-44 rounded-full bg-slate-200" />
                </div>
                <div className="flex gap-2">
                  <div className="h-12 w-16 rounded-[14px] border border-sky-100 bg-sky-50" />
                  <div className="h-12 w-16 rounded-[14px] border border-emerald-100 bg-emerald-50" />
                </div>
              </div>
              <div className="mt-2.5 h-16 w-full rounded-[18px] border border-slate-200 bg-slate-50" />
            </div>

            {/* FAQ skeleton */}
            <div className="rounded-[28px] border border-white/70 bg-[linear-gradient(180deg,#fffdf8,#f8fbff)] px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-4">
              <div className="h-2 w-8 rounded-full bg-slate-200" />
              <div className="mt-1.5 h-4 w-44 rounded-full bg-slate-200" />
              <div className="mt-2.5 space-y-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="rounded-[18px] border border-white/80 bg-white/80 px-3.5 py-3">
                    <div className={`h-3 rounded-full bg-slate-200 ${i % 2 === 0 ? "w-3/4" : "w-2/3"}`} />
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>

        {/* ── Layer 2: Glassmorphism connect overlay ── */}
        <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-gradient-to-b from-white/20 via-slate-100/30 to-white/40 px-4 py-8 backdrop-blur-[3px] dark:from-slate-950/20 dark:via-slate-950/45 dark:to-slate-950/35">
          <div className="flex w-full max-w-xl flex-col gap-4">
            <section className="mx-auto flex w-full max-w-[340px] flex-col items-center rounded-[32px] border border-white/80 bg-white/78 p-8 text-center shadow-[0_32px_80px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl dark:border-white/10 dark:bg-[rgba(11,18,32,0.82)] dark:shadow-[0_32px_90px_rgba(0,0,0,0.42)] sm:p-10">
              <div className="flex h-[76px] items-center justify-center rounded-[22px] border border-white/90 bg-white/90 px-6 shadow-[0_12px_32px_rgba(148,163,184,0.14)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.08]">
                <ThemeLongLogo
                  alt="DustSwap"
                  width={160}
                  height={38}
                  priority
                  className="h-auto w-full max-w-[140px] sm:max-w-[160px]"
                />
              </div>
              <h2 className="mt-7 text-xl font-black tracking-tight text-slate-950 dark:text-white sm:text-2xl">
                Connect your wallet to start your journey at DustSwap
              </h2>
              <p className="mt-2.5 max-w-xs text-sm leading-6 text-slate-500 dark:text-slate-300">
                Use <span aria-hidden="true">&bull;</span> Contribute{" "}
                <span aria-hidden="true">&bull;</span> Earn{" "}
                <span aria-hidden="true">&bull;</span> Repeat.
              </p>
              <div className="mt-7 flex origin-center justify-center scale-105 sm:scale-110">
                <WalletConnectButton
                  showDisconnect
                  className="bg-[linear-gradient(135deg,#2563eb_0%,#0ea5e9_52%,#ffffff_180%)] text-white shadow-[0_20px_40px_rgba(37,99,235,0.28)] hover:border-transparent hover:text-white"
                  description="Connect your wallet to start your journey at DustSwap."
                />
              </div>
            </section>
          </div>
        </div>

      </div>
    );
  }

  return (
    <div
      className="theme-page bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_22%),linear-gradient(180deg,#f8fafc,#fef7ed_45%,#eff6ff)] px-3 py-4 pb-16 sm:px-6 sm:py-8"
      style={{ minHeight: "calc(100dvh - 4rem)" }}
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 sm:gap-5 xl:max-w-5xl 2xl:max-w-6xl">
        {isConnected ? (
          <WalletLinkPromo address={address} onOpenLinking={openWalletLinking} />
        ) : null}

        {toast ? (
          <div
            className={`rounded-[18px] border px-4 py-3 text-sm shadow-[0_16px_36px_rgba(15,23,42,0.08)] ${
              toast.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {toast.message}
          </div>
        ) : null}

        {isConnected && !isOnBase ? (
          <section className="rounded-[22px] border border-amber-200 bg-amber-50/95 px-4 py-3 shadow-[0_16px_36px_rgba(245,158,11,0.12)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-700">
                  Base Network Required
                </p>
                <p className="mt-1 text-sm leading-6 text-amber-900">
                  Daily check-in and streak save only work on Base. Switch your wallet to Base to continue on this page.
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  void promptSwitchToBase("Wallet switched to Base. You can continue now.")
                }
                disabled={isSwitchingToBase}
                className="inline-flex shrink-0 items-center justify-center rounded-[14px] bg-[linear-gradient(135deg,#f59e0b,#f97316)] px-4 py-2.5 text-sm font-black text-white shadow-[0_12px_28px_rgba(249,115,22,0.22)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSwitchingToBase ? "Switching..." : "Switch to Base"}
              </button>
            </div>
          </section>
        ) : null}

        <section className="relative rounded-[28px] border border-white/70 bg-white/82 px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur sm:px-5 sm:py-4">
          <button
            type="button"
            onClick={() => {
              openProfileSettings();
            }}
            className="absolute right-3 top-3 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/90 text-slate-500 shadow-sm transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700"
            aria-label="Open profile settings"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.075.04.149.083.222.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a7.7 7.7 0 0 1 0 .255c-.007.378.138.75.431.991l1.004.827c.424.35.534.955.26 1.431l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.6 6.6 0 0 1-.22.128c-.333.183-.583.495-.646.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.02-.397-1.11-.94l-.213-1.281c-.063-.374-.313-.686-.646-.87a6.6 6.6 0 0 1-.22-.127c-.326-.196-.721-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.241.437-.613.43-.991a7.7 7.7 0 0 1 0-.255c.007-.379-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.431l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.355.133.75.072 1.076-.124.073-.044.147-.086.222-.128.333-.183.583-.495.646-.869l.213-1.281Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
              />
            </svg>
          </button>

          <div ref={profileMenuRef} className="relative z-20 max-w-full pr-10 sm:max-w-xl">
            <button
              type="button"
              onClick={() => setIsProfileMenuOpen((current) => !current)}
              className="group flex max-w-full items-center gap-3 rounded-[20px] border border-transparent p-1 pr-3 text-left transition hover:border-sky-100 hover:bg-white/70 focus-visible:border-sky-200 focus-visible:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-100"
              aria-label="Open profile wallet menu"
              aria-expanded={isProfileMenuOpen}
              aria-haspopup="menu"
            >
              {profileDisplay.avatarUrl ? (
                <img
                  src={profileDisplay.avatarUrl}
                  alt="Profile"
                  className="h-11 w-11 shrink-0 rounded-[14px] border border-white/70 object-cover shadow-[0_10px_28px_rgba(56,189,248,0.18)]"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border border-sky-200 bg-[linear-gradient(135deg,#38bdf8,#0ea5e9)] text-base font-black text-white shadow-[0_10px_28px_rgba(14,165,233,0.22)]">
                  {profileDisplay.initials}
                </span>
              )}

              <span className="min-w-0">
                <span className="block text-[9px] font-black uppercase tracking-[0.32em] text-slate-500">
                  Profile Hub
                </span>
                <span className="block truncate text-xl font-black tracking-tight text-slate-950">
                  {profileDisplay.displayName}
                </span>
                <span className="block truncate text-xs text-slate-600">
                  {profileDisplay.subtitle}
                </span>
              </span>

              <span
                className={`ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition group-hover:border-sky-200 group-hover:text-sky-600 ${
                  isProfileMenuOpen ? "rotate-180 border-sky-200 text-sky-600" : ""
                }`}
                aria-hidden="true"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="m6 9 6 6 6-6"
                  />
                </svg>
              </span>
            </button>

            {isProfileMenuOpen && address ? (
              <div
                role="menu"
                className="absolute left-0 top-[calc(100%+0.5rem)] z-40 w-[calc(100vw-2rem)] max-w-[20rem] rounded-[20px] border border-slate-200 bg-white p-2 shadow-[0_22px_52px_rgba(15,23,42,0.16)]"
              >
                <div className="rounded-[16px] bg-slate-50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">
                    Connected Wallet
                  </p>
                  <p className="mt-1 font-mono text-sm font-black text-slate-900">
                    {shortAddress(address)}
                  </p>
                </div>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleProfileDisconnect()}
                  disabled={isDisconnectingProfile}
                  className="mt-2 flex w-full items-center justify-center rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-sm font-black text-slate-700 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label="Disconnect wallet"
                >
                  {isDisconnectingProfile ? (
                    <span className="flex items-center gap-2">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-rose-200 border-t-rose-500" />
                      Disconnecting...
                    </span>
                  ) : (
                    "Disconnect"
                  )}
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
            <MiniMetric
              label="Total PP"
              value={`${formatNumber(balance?.totalPoints || 0)} PP`}
              accent="sky"
              isLoading={isLoading}
            />
            <MiniMetric
              label="Rank"
              value={`#${balance?.rank || "--"}`}
              accent="amber"
              isLoading={isLoading}
            />
            <MiniMetric
              label="All-Time Volume"
              value={`$${(stats?.swapVolume || 0).toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              })}`}
              accent="sky"
              isLoading={isLoading}
            />
            <MiniMetric
              label="Total Referrals"
              value={String(referral?.friendsJoined || 0)}
              accent="emerald"
              isLoading={isLoading}
            />
          </div>
        </section>

        {isProfileCompletionLoading || shouldShowProfileCompletionGuide ? (
          <ProfileCompletionGuide
            guide={profileCompletion}
            isLoading={isProfileCompletionLoading}
            isModalOpen={isProfileCompletionModalOpen}
            isClaimingReward={isClaimingProfileCompletionReward}
            onContinue={handleProfileCompletionContinue}
            onDismissModal={handleDismissProfileCompletionModal}
          />
        ) : null}

        <DailyCheckInModule
          balance={balance}
          isCheckingIn={isCheckingIn}
          isSaving={isSaving}
          isResetting={isResetting}
          checkInStage={checkInStage}
          recoveryStage={recoveryStage}
          celebration={celebration}
          walletReady={Boolean(address) && !isSwitchingToBase}
          onCheckIn={() => void handleCheckIn()}
          onSave={() => void handleSave()}
          onReset={() => void handleReset()}
        />

        <section
          ref={referralSectionRef}
          className="rounded-[28px] border border-white/70 bg-white/82 px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[9px] font-black uppercase tracking-[0.32em] text-slate-500">
                Referral Vault
              </p>
              <h2 className="text-base font-black tracking-tight text-slate-950">
                Invite friends, earn 20% of their points
              </h2>
            </div>
            <div className="flex shrink-0 gap-2">
              <div className="rounded-[14px] border border-sky-100 bg-sky-50 px-2.5 py-1.5 text-center">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-sky-500">Friends</p>
                <p className="text-sm font-black text-sky-800">{String(referral?.friendsJoined || 0)}</p>
              </div>
              <div className="rounded-[14px] border border-emerald-100 bg-emerald-50 px-2.5 py-1.5 text-center">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-emerald-500">Ref PP</p>
                <p className="text-sm font-black text-emerald-800">{formatNumber(referral?.pointsEarned || 0)}</p>
              </div>
            </div>
          </div>

          {!isLoading && referral?.hasReferrer === false && pendingReferralCode && (
            <div className="mt-2.5 rounded-[18px] border border-sky-100 bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.08),transparent_50%),linear-gradient(180deg,#f0f9ff,#eff6ff)] p-3">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-200 bg-white shadow-sm">
                  <svg className="h-3.5 w-3.5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-sky-600">
                    Invite attached
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] font-bold tracking-[0.04em] text-slate-800">
                    {pendingReferralCode}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-[1.6] text-slate-500">
                    This invite code is saved and will activate after your first onchain check-in or PP claim.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Inline referral code entry \u2014 shown only if user has no referrer yet */}
          {!isLoading && referral?.hasReferrer === false && !pendingReferralCode && !inlineSuccess && (
            <div className="mt-2.5 rounded-[18px] border border-sky-100 bg-[radial-gradient(circle_at_top_right,rgba(99,102,241,0.08),transparent_50%),linear-gradient(180deg,#f0f9ff,#eff6ff)] p-3">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-200 bg-white shadow-sm">
                  <svg className="h-3.5 w-3.5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-sky-600">Enter referral code</p>
                  <p className="text-[11px] leading-[1.5] text-slate-500">
                    Get <span className="font-bold text-slate-700">500 PP</span> when you link an invite code. Both users receive the reward.
                  </p>
                </div>
              </div>
              <div className="mt-2.5 flex flex-col gap-1.5 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={inlineCode}
                    onChange={(e) => {
                      setInlineCode(e.target.value.toUpperCase());
                      setInlineError(null);
                      setInlineInfo(null);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleApplyInline(); }}
                    placeholder="e.g. DUST-XXXXX"
                    maxLength={32}
                    disabled={isApplyingInline}
                    className={`w-full rounded-[12px] border px-3 py-2 font-mono text-[12px] font-bold tracking-[0.04em] text-slate-800 outline-none transition-all placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-300 ${
                      inlineValidation.status === "valid"
                        ? "border-emerald-300 bg-emerald-50 focus:ring-2 focus:ring-emerald-200"
                        : inlineValidation.status === "invalid"
                          ? "border-rose-300 bg-rose-50 focus:ring-2 focus:ring-rose-200"
                          : "border-slate-200 bg-white focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    }`}
                  />
                  {inlineValidation.status === "validating" && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-200 border-t-sky-500" />
                    </div>
                  )}
                  {inlineValidation.status === "valid" && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <svg className="h-3.5 w-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleApplyInline()}
                  disabled={!inlineCode.trim() || isApplyingInline}
                  className={`shrink-0 rounded-[12px] px-4 py-2 text-[12px] font-black text-white shadow-sm transition active:scale-[0.98] ${
                    inlineCode.trim() && !isApplyingInline
                      ? "bg-[linear-gradient(135deg,#0ea5e9,#6366f1)] hover:-translate-y-0.5 hover:shadow-md"
                      : "cursor-not-allowed bg-slate-200 text-slate-400 shadow-none"
                  }`}
                >
                  {isApplyingInline ? (
                    <span className="flex items-center gap-1.5">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      Applying…
                    </span>
                  ) : (
                    "Apply Code"
                  )}
                </button>
              </div>
              {(inlineValidation.status === "valid" || inlineValidation.status === "invalid") && (
                <p className={`mt-1 text-[11px] font-semibold ${inlineValidation.status === "valid" ? "text-emerald-600" : "text-rose-600"}`}>
                  {inlineValidation.status === "valid"
                    ? (inlineValidation as { status: "valid"; message: string }).message
                    : (inlineValidation as { status: "invalid"; message: string }).message}
                </p>
              )}
              {inlineInfo && <p className="mt-1 text-[11px] font-semibold text-sky-600">{inlineInfo}</p>}
              {inlineError && <p className="mt-1 text-[11px] font-semibold text-rose-600">{inlineError}</p>}
            </div>
          )}

          {/* Invite activated badge \u2014 shown when user is already referred */}
          {!isLoading && referral?.hasReferrer === true && (
            <div className="mt-2.5 flex items-center gap-2 rounded-[14px] border border-emerald-200 bg-emerald-50 px-3 py-2">
              <svg className="h-4 w-4 shrink-0 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-700">Invite activated</p>
            </div>
          )}

          {/* Inline success state */}
          {inlineSuccess && (
            <div className="mt-2.5 flex items-center gap-2 rounded-[14px] border border-emerald-200 bg-emerald-50 px-3 py-2">
              <svg className="h-4 w-4 shrink-0 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-[11px] font-black text-emerald-700">Referral linked! +500 PP incoming.</p>
            </div>
          )}

          <div className="mt-2.5 rounded-[18px] border border-slate-200 bg-[#f8fbff] p-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.24em] text-slate-500">
              Your Link
            </p>
            {hasCompletedFirstCheckIn ? (
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                <div className="flex-1 break-all rounded-[12px] border border-slate-200 bg-white px-2.5 py-2 font-mono text-[11px] font-semibold leading-5 text-sky-700">
                  {referralLink || "LOADING..."}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!referralLink) {
                      return;
                    }
                    navigator.clipboard.writeText(referralLink);
                    setIsCopied(true);
                    setToast({ kind: "success", message: "Referral link copied." });
                    window.setTimeout(() => setIsCopied(false), 1800);
                  }}
                  className="rounded-[12px] bg-[linear-gradient(135deg,#0ea5e9,#22c55e)] px-4 py-2 text-sm font-black text-white shadow-[0_8px_20px_rgba(14,165,233,0.18)] transition hover:-translate-y-0.5"
                >
                  {isCopied ? "Copied!" : "Copy Link"}
                </button>
              </div>
            ) : (
              <div className="mt-1.5 rounded-[14px] border border-amber-100 bg-amber-50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-amber-700">
                  Referral link locked
                </p>
                <p className="mt-1.5 text-sm font-black text-amber-900">
                  Complete your first onchain check-in to unlock your invite link.
                </p>
                <p className="mt-1.5 text-[12px] leading-5 text-amber-800">
                  After your first check-in, your personal referral link will unlock here and you can invite friends to earn 20% of their points.
                </p>
                <p className="mt-1.5 text-[11px] font-semibold text-amber-700">
                  Your first check-in unlocks referrals.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="rounded-[28px] border border-white/70 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.12),transparent_28%),linear-gradient(180deg,#fffdf8,#f8fbff)] px-4 py-3 shadow-[0_20px_70px_rgba(15,23,42,0.08)] sm:px-5 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[9px] font-black uppercase tracking-[0.32em] text-slate-500">
                FAQ
              </p>
              <h2 className="text-base font-black tracking-tight text-slate-950">
                DustSwap quick answers
              </h2>
            </div>
          </div>

          <div className="mt-2.5 space-y-2">
            {PROFILE_FAQ_ITEMS.map((item) => (
              <details
                key={item.question}
                className="group rounded-[18px] border border-white/80 bg-white/80 px-3.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <span className="text-xs font-black tracking-tight text-slate-900 sm:text-sm">
                    {item.question}
                  </span>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-base font-medium text-slate-500 transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>

                <ul className="mt-2.5 space-y-1.5 border-t border-slate-200/80 pt-2.5 text-xs leading-5 text-slate-600">
                  {item.answers.map((answer) => (
                    <li key={answer} className="flex gap-2">
                      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                      <span>{answer}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </section>
      </div>

      <ProfileSettingsModal
        open={isSettingsOpen}
        address={address}
        profileSettings={profileSettings}
        isProfileSettingsLoading={isProfileSettingsLoading}
        profileSettingsError={profileSettingsError}
        onRetryLoad={() => void fetchProfileSettingsData()}
        onClose={closeProfileSettings}
        onSaved={handleProfileSettingsSaved}
        initialSection={settingsInitialSection}
        initialFocusTarget={settingsInitialFocusTarget}
        connectionSource={settingsConnectionSource}
      />
    </div>
  );
}

export default function ProfilePage() {
  return (
    <ErrorBoundary>
      <ProfilePageContent />
    </ErrorBoundary>
  );
}
