export type QuestCategory = "social" | "onchain";
export type QuestCampaignKey = "general" | "cofounder_pass";
export type QuestPlatform = "x" | "base" | "dustswap";
export type QuestActionType =
  | "swap_volume"
  | "swap_count"
  | "like"
  | "post"
  | "follow"
  | "repost"
  | "reply"
  | "visit";
export type QuestVerificationType =
  | "swap_volume"
  | "x_post_link"
  | "delay_gate"
  | "delay_gate_retry";
export type QuestProgressWindow = "once" | "daily" | "weekly";

export type QuestRules = {
  delaySeconds?: number;
  fakeFailureCount?: number;
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
  fakeFailuresServed: number;
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
      displayName?: string;
      profileImageUrl?: string;
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
