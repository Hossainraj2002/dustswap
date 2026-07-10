export type QuestCategory = "social" | "onchain";
export type QuestCampaignKey = "general" | "cofounder_pass";
export type QuestPlatform = "x" | "base" | "dustswap" | "discord";
export type QuestActionType =
  | "swap_volume"
  | "swap_count"
  | "sweep_volume"
  | "sweep_count"
  | "sweep_tokens_at_once"
  | "sweep_tokens_total"
  | "join_discord"
  | "like"
  | "post"
  | "share_referral_x"
  | "follow"
  | "repost"
  | "reply"
  | "visit";
export type QuestVerificationType =
  | "swap_volume"
  | "sweep"
  | "x_post_link"
  | "discord_guild_member"
  | "delay_gate"
  | "delay_gate_retry";
export type QuestProgressWindow = "once" | "daily" | "weekly";

export type QuestRules = {
  delaySeconds?: number;
  chainId?: number;
  chainIds?: number[];
  tokenAddress?: string;
  tokenAddresses?: string[];
  tokenMatch?: "input" | "output" | "input_or_output";
  requiredMention?: string;
  requiredMentionsAny?: string[];
  requiredAnyOf?: string[];
  requiredHashtags?: string[];
  requiredLinks?: string[];
  requireUserReferralLink?: boolean;
  composeText?: string;
  externalUrl?: string;
  source?: string;
  [key: string]: unknown;
};

export type QuestProgress = {
  status: string;
  value: number;
  targetValue: number;
  verificationAttempts: number;
  nextVerificationAt: string | null;
  openedAt: string | null;
  completedAt: string | null;
};

export type QuestItem = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  campaignKey: QuestCampaignKey | string;
  category: QuestCategory;
  platform: QuestPlatform;
  actionType: QuestActionType;
  verificationType: QuestVerificationType;
  progressWindow: QuestProgressWindow;
  rewardKind: string;
  rewardPoints: number;
  targetValue: number;
  ctaLabel: string | null;
  ctaUrl: string | null;
  rules: QuestRules;
  progress: QuestProgress | null;
  endsAt?: string | null;
};

export type QuestCampaignSummary = {
  key: string;
  label: string;
  totalQuests: number;
  completedQuests: number;
  remainingQuests: number;
  isComplete: boolean;
  isWhitelisted: boolean;
  whitelistedAt: string | null;
};

export type QuestBoardResponse = {
  success: boolean;
  linkedAccounts: Record<
    string,
    {
      username?: string;
      platformUserId?: string;
      xUserId?: string | null;
      discordUserId?: string | null;
      displayName?: string;
      profileImageUrl?: string;
      connected?: boolean;
      connectedAt?: string | null;
      legacyManual?: boolean;
      joined?: boolean;
      pending?: boolean | null;
      joinedAt?: string | null;
      verifiedAt?: string | null;
      guildId?: string | null;
      roles?: string[];
    }
  >;
  campaigns: Record<string, QuestCampaignSummary>;
  quests: QuestItem[];
  serverTime: string;
  error?: string;
};

export type AdminQuestInput = {
  id?: string;
  slug: string;
  title: string;
  description?: string | null;
  campaignKey?: QuestCampaignKey | string;
  category: QuestCategory;
  platform: QuestPlatform;
  actionType: QuestActionType;
  verificationType: QuestVerificationType;
  progressWindow: QuestProgressWindow;
  rewardKind?: string;
  rewardPoints: number;
  targetValue?: number;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  status?: string;
  isActive?: boolean;
  sortOrder?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  rules?: QuestRules;
};

export type AdminManualPointsEntryInput = {
  address: string;
  points: number;
};

export type AdminManualPointsGrantResult = {
  requestId: string;
  recipientCount: number;
  grantedCount: number;
  reusedCount: number;
  totalRequestedPoints: number;
  totalAwardedPoints: number;
  grants: Array<{
    address: string;
    userId: number;
    requestedPoints: number;
    totalAwarded: number;
    totalPoints: number;
    createdAt: string | null;
    idempotent: boolean;
  }>;
};

export type AdminWalletReplacementLog = {
  level: "plus" | "minus" | "backup" | "warning" | "info";
  message: string;
  count?: number;
};

export type AdminWalletReplacementCounts = Record<string, number>;

export type AdminWalletReplacementPreview = {
  oldWallet: string;
  newWallet: string;
  canReplace: boolean;
  requiresConfirmation: boolean;
  relation: "unused" | "same_account" | "different_user";
  oldAccount: {
    userId: number;
    address: string;
    totalPoints: number;
    currentStreak: number;
    longestStreak: number;
    counts: AdminWalletReplacementCounts;
    totalRows: number;
  };
  newWalletState: {
    ownerUserId: number | null;
    ownerAddress: string | null;
    isPrimary: boolean;
    totalPoints: number;
    counts: AdminWalletReplacementCounts;
    totalRows: number;
  };
  warnings: string[];
};

export type AdminWalletReplacementResult = {
  replacementId: number;
  oldWallet: string;
  newWallet: string;
  primaryUserId: number;
  displacedUserId: number | null;
  logs: AdminWalletReplacementLog[];
  backupSaved: boolean;
};

export type AdminWalletReplacementHistoryEntry = AdminWalletReplacementResult & {
  note: string | null;
  createdAt: string;
};
