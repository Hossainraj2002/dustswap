import { randomBytes, createHash } from "crypto";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { pointsEngine } from "./pointsEngine";
import { recordSwap } from "./swapRecorder";
import { supabase } from "./supabase";
import { runtimeCache } from "../utils/runtimeCache";
import { isAllowedAppDomain, isAllowedAppOrigin } from "../config/appOrigins";
import {
  getConnectedXUserId,
  isConnectedXAccount,
  toXAccountSummary,
  xVerificationService,
  type XSocialAccountRecord,
} from "./xVerification";

type QuestCategory = "social" | "onchain";
type QuestCampaignKey = "general" | "cofounder_pass";
type QuestPlatform = "x" | "base" | "dustswap";
type QuestActionType =
  | "swap_volume"
  | "swap_count"
  | "like"
  | "post"
  | "follow"
  | "repost"
  | "reply"
  | "visit";
type QuestVerificationType =
  | "swap_volume"
  | "x_post_link"
  | "delay_gate"
  | "delay_gate_retry";
type QuestProgressWindow = "once" | "daily" | "weekly";

type QuestRules = {
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
  composeText?: string;
  externalUrl?: string;
  targetXUserId?: string;
  targetUserId?: string;
  targetUsername?: string;
  targetXUsername?: string;
  parentTweetId?: string;
  replyToTweetId?: string;
  source?: string;
  [key: string]: unknown;
};

type QuestRecord = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  campaign_key: QuestCampaignKey | string;
  category: QuestCategory;
  platform: QuestPlatform;
  action_type: QuestActionType;
  verification_type: QuestVerificationType;
  progress_window: QuestProgressWindow;
  reward_kind: string;
  reward_points: number;
  target_value: number;
  cta_label: string | null;
  cta_url: string | null;
  status: string;
  is_active: boolean;
  sort_order: number;
  starts_at: string | null;
  ends_at: string | null;
  rules: QuestRules | null;
  created_at: string;
  updated_at: string;
};

type QuestProgressRecord = {
  id: number;
  quest_id: string;
  user_id: number;
  cycle_key: string;
  status: string;
  progress: number;
  target_value: number;
  verification_attempts: number;
  fake_failures_served: number;
  opened_at: string | null;
  next_verification_at: string | null;
  completed_at: string | null;
  rewarded_at: string | null;
  verified_by_api?: boolean | null;
  verified_at?: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
};

type SocialAccountRecord = {
  id: number;
  user_id: number;
  platform: QuestPlatform;
  platform_user_id: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  access_token: string | null;
  refresh_token: string | null;
  scope: string | null;
  token_expires_at: string | null;
  metadata: Record<string, unknown> | null;
};

type QuestCampaignWhitelistRecord = {
  id: number;
  campaign_key: string;
  user_id: number;
  wallet_address: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ManualXUsernameSaveResult = {
  success: true;
  username: string;
};

type StartDelayQuestResult = {
  success: true;
  questId: string;
  nextVerificationAt?: string | null;
  idempotent?: boolean;
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

export type SwapActivityInput = {
  address: string;
  txHash: string;
  chainId: number;
  amountUsd?: number;
  inputToken?: string | null;
  outputToken?: string | null;
  metadata?: Record<string, unknown>;
};

export type XAccountAuthInput = {
  address?: string;
  message?: string;
  signature?: Hex;
  returnTo?: string | null;
};

type OpenOceanWalletTransaction = {
  txHash?: string;
  tradeTime?: string;
  inAmount?: string;
  outAmount?: string;
  inToken?: string;
  outToken?: string;
  usd_valuation?: number | string;
};

const X_SCOPES = ["tweet.read", "users.read", "offline.access"];
const X_ACCOUNT_STATEMENT = "DustSwap X Account Connection";
const X_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const X_OAUTH_STATE_CACHE_TTL_MS = 10 * 60 * 1000;
const X_STORE_OAUTH_TOKENS = ["1", "true", "yes", "on"].includes(
  String(process.env.X_STORE_OAUTH_TOKENS || "").trim().toLowerCase()
);
const OPENOCEAN_API_BASE =
  process.env.OPENOCEAN_API_BASE || "https://open-api.openocean.finance/v3";
const OPENOCEAN_SWAP_SYNC_PAGE_SIZE = Math.min(
  50,
  Math.max(1, Number(process.env.OPENOCEAN_SWAP_SYNC_PAGE_SIZE || "50"))
);
const OPENOCEAN_SWAP_SYNC_MAX_RECORDS = Math.min(
  50,
  Math.max(
    1,
    Number(
      process.env.OPENOCEAN_SWAP_SYNC_MAX_RECORDS ||
        String(OPENOCEAN_SWAP_SYNC_PAGE_SIZE)
    )
  )
);
const OPENOCEAN_SWAP_SYNC_CONCURRENCY = Math.min(
  1,
  Math.max(1, Number(process.env.OPENOCEAN_SWAP_SYNC_CONCURRENCY || "1"))
);
const OPENOCEAN_SWAP_SYNC_TIMEOUT_MS = Math.min(
  10_000,
  Math.max(1_000, Number(process.env.OPENOCEAN_SWAP_SYNC_TIMEOUT_MS || "6000"))
);
const GENERAL_CAMPAIGN_KEY = "general";
const COFOUNDER_PASS_CAMPAIGN_KEY = "cofounder_pass";
const QUEST_BOARD_CACHE_TTL_MS = 10_000;
const SWAP_SYNC_DEDUPE_TTL_MS = 25_000;
const MANUAL_X_USERNAME_DEDUPE_TTL_MS = 15_000;
const START_DELAY_QUEST_DEDUPE_TTL_MS = 15_000;

const publicClient = createPublicClient({
  chain: base,
  transport: http(
    process.env.BASE_RPC_URL ||
      process.env.NEXT_PUBLIC_BASE_RPC_URL ||
      "https://mainnet.base.org"
  ),
});

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeRules(value: unknown): QuestRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as QuestRules;
}

function normalizeNumberList(value: unknown) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [
    ...new Set(
      values
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    ),
  ];
}

function getQuestChainIds(rules: QuestRules) {
  return normalizeNumberList(rules.chainIds?.length ? rules.chainIds : rules.chainId);
}

function normalizeTokenMatch(value: unknown) {
  return value === "input" || value === "output" || value === "input_or_output"
    ? value
    : "input_or_output";
}

function getQuestTokenFilter(rules: QuestRules) {
  const rulesRecord = rules as QuestRules & { token?: unknown };
  const tokenRule =
    rulesRecord.token &&
    typeof rulesRecord.token === "object" &&
    !Array.isArray(rulesRecord.token)
      ? (rulesRecord.token as Record<string, unknown>)
      : null;
  const rawAddresses =
    rules.tokenAddresses?.length
      ? rules.tokenAddresses
      : rules.tokenAddress
        ? [rules.tokenAddress]
        : typeof tokenRule?.address === "string"
          ? [tokenRule.address]
          : Array.isArray(tokenRule?.addresses)
            ? tokenRule.addresses
            : [];
  const addresses: string[] = [
    ...new Set(
      rawAddresses
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => isAddress(value))
    ),
  ];

  if (addresses.length === 0) {
    return null;
  }

  return {
    addresses,
    match: normalizeTokenMatch(rules.tokenMatch || tokenRule?.match),
  };
}

function getMetadataAddress(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized && isAddress(normalized) ? normalized : null;
}

function getSwapTransactionKey(chainId: number, txHash: string) {
  return `${chainId}:${String(txHash || "").trim().toLowerCase()}`;
}

function getReferenceDateFromDayKey(dayKey: string) {
  const parsed = new Date(`${dayKey}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getRowAddress(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized && isAddress(normalized) ? normalized : null;
}

function getSwapTransactionTokenAddress(
  row: {
    src_token_address?: string | null;
    dst_token_address?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  side: "input" | "output"
) {
  const explicitAddress = getRowAddress(
    side === "input" ? row.src_token_address : row.dst_token_address
  );
  if (explicitAddress) {
    return explicitAddress;
  }

  const metadata = row.metadata || {};
  return side === "input"
    ? getMetadataAddress(metadata, "inputTokenAddress") ||
        getMetadataAddress(metadata, "inputToken")
    : getMetadataAddress(metadata, "outputTokenAddress") ||
        getMetadataAddress(metadata, "outputToken");
}

function swapTransactionMatchesToken(
  row: {
    src_token_address?: string | null;
    dst_token_address?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  tokenFilter: ReturnType<typeof getQuestTokenFilter>
) {
  if (!tokenFilter) {
    return true;
  }

  const inputTokenAddress = getSwapTransactionTokenAddress(row, "input");
  const outputTokenAddress = getSwapTransactionTokenAddress(row, "output");
  const matchesInput = inputTokenAddress
    ? tokenFilter.addresses.includes(inputTokenAddress)
    : false;
  const matchesOutput = outputTokenAddress
    ? tokenFilter.addresses.includes(outputTokenAddress)
    : false;

  if (tokenFilter.match === "input") {
    return matchesInput;
  }

  if (tokenFilter.match === "output") {
    return matchesOutput;
  }

  return matchesInput || matchesOutput;
}

function normalizeCampaignKey(value?: string | null) {
  const normalized = String(value || GENERAL_CAMPAIGN_KEY)
    .trim()
    .toLowerCase();

  return normalized || GENERAL_CAMPAIGN_KEY;
}

function getCampaignLabel(campaignKey: string) {
  if (campaignKey === COFOUNDER_PASS_CAMPAIGN_KEY) {
    return "coFounder pass";
  }

  return "General";
}

function campaignSupportsWhitelist(campaignKey: string) {
  return campaignKey === COFOUNDER_PASS_CAMPAIGN_KEY;
}

function getNow() {
  return new Date();
}

function getUtcDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getUtcWeekKey(date: Date) {
  const normalized = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const day = normalized.getUTCDay() || 7;
  normalized.setUTCDate(normalized.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(normalized.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((normalized.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return `${normalized.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getCycleKey(windowType: QuestProgressWindow, date = getNow()) {
  if (windowType === "daily") {
    return getUtcDayKey(date);
  }

  if (windowType === "weekly") {
    return getUtcWeekKey(date);
  }

  return "global";
}

function getWindowBounds(windowType: QuestProgressWindow, date = getNow()) {
  if (windowType === "daily") {
    const start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start, end };
  }

  if (windowType === "weekly") {
    const start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
    const day = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - (day - 1));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return { start, end };
  }

  return null;
}

function isQuestLive(quest: QuestRecord, now = getNow()) {
  if (!quest.is_active || quest.status !== "published") {
    return false;
  }

  if (quest.starts_at && new Date(quest.starts_at) > now) {
    return false;
  }

  if (quest.ends_at && new Date(quest.ends_at) < now) {
    return false;
  }

  return true;
}

function createCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function createCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function hashOAuthState(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

function getOAuthStateCacheKey(stateHash: string) {
  return `x-oauth-state:${stateHash}`;
}

function getDefaultReturnTo() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return new URL("/quests", appUrl).toString();
}

function normalizeReturnTo(returnTo?: string | null) {
  const fallback = getDefaultReturnTo();
  if (!returnTo) {
    return fallback;
  }

  try {
    const url = new URL(returnTo, fallback);
    const allowedOrigin = isAllowedAppOrigin(url.origin);
    if (!allowedOrigin) {
      return fallback;
    }

    return url.toString();
  } catch {
    return fallback;
  }
}

function parseXAccountMessage(message: string) {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== X_ACCOUNT_STATEMENT) {
    throw new Error("Invalid X connection message");
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    fields.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim()
    );
  }

  return {
    address: fields.get("address") || "",
    action: fields.get("action") || "",
    timestamp: fields.get("timestamp") || "",
    nonce: fields.get("nonce") || "",
    domain: fields.get("domain") || "",
  };
}

function getXClientId() {
  const clientId = process.env.X_CLIENT_ID;
  if (!clientId) {
    throw new Error("X_CLIENT_ID is required");
  }
  return clientId;
}

function getXClientSecret() {
  return process.env.X_CLIENT_SECRET;
}

function getXRedirectUri() {
  const redirectUri = process.env.X_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("X_REDIRECT_URI is required");
  }
  return redirectUri;
}

function normalizeXUsernameInput(input: string) {
  const raw = input.trim().replace(/^@+/, "");
  if (!raw) {
    throw new Error("Enter your X username first");
  }

  if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) {
    throw new Error("Enter a valid X username");
  }

  return {
    display: `@${raw}`,
    key: raw.toLowerCase(),
  };
}

function normalizeMentionValue(input: string) {
  return input.trim().replace(/^@+/, "").toLowerCase();
}

function normalizeHashtagValue(input: string) {
  return input.trim().replace(/^#+/, "").toLowerCase();
}

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function getNormalizedLinkedXKeys(account: SocialAccountRecord) {
  const candidates = new Set<string>();

  const rawPlatformUserId = String(account.platform_user_id || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  if (rawPlatformUserId) {
    candidates.add(rawPlatformUserId);
  }

  const rawUsername = String(account.username || "").trim();
  if (rawUsername) {
    try {
      candidates.add(normalizeXUsernameInput(rawUsername).key);
    } catch {
      // Ignore malformed legacy usernames and fall back to platform_user_id.
    }
  }

  return Array.from(candidates);
}

function getLinkedXUsernameDisplay(account: SocialAccountRecord) {
  const rawUsername = String(account.username || "").trim();
  if (rawUsername) {
    return rawUsername.startsWith("@") ? rawUsername : `@${rawUsername}`;
  }

  const key = getNormalizedLinkedXKeys(account)[0];
  return key ? `@${key}` : "@your_saved_x_username";
}

function extractPostId(input: string) {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(/status\/(\d+)/i);
  return match?.[1] ?? null;
}

function getXUsernameFromUrl(input?: string | null) {
  if (!input) {
    return null;
  }

  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host)) {
      return null;
    }

    const [candidate] = parsed.pathname.split("/").filter(Boolean);
    if (!candidate || ["i", "intent"].includes(candidate.toLowerCase())) {
      return null;
    }

    return normalizeMentionValue(candidate);
  } catch {
    return null;
  }
}

function getTargetXUserRef(quest: QuestRecord, rules: QuestRules) {
  const rulesRecord = rules as QuestRules & Record<string, unknown>;
  const slug = quest.slug.toLowerCase();
  const userIdCandidates = [
    rules.targetXUserId,
    rules.targetUserId,
    rulesRecord.target_x_user_id,
    rulesRecord.target_user_id,
    slug.includes("founder") ? process.env.FOUNDER_X_USER_ID : null,
    slug.includes("dustswap") ? process.env.DUSTSWAP_X_USER_ID : null,
  ];
  const usernameCandidates = [
    rules.targetXUsername,
    rules.targetUsername,
    rulesRecord.target_x_username,
    rulesRecord.target_username,
    slug.includes("founder") ? process.env.FOUNDER_X_USERNAME || "akbarx402" : null,
    slug.includes("dustswap") ? process.env.DUSTSWAP_X_USERNAME || "DustswapOnBase" : null,
    getXUsernameFromUrl(quest.cta_url),
    getXUsernameFromUrl(String(rules.externalUrl || "")),
  ];

  const userId = userIdCandidates
    .map((value) => String(value || "").trim())
    .find((value) => /^\d+$/.test(value));
  const username = usernameCandidates
    .map((value) => String(value || "").trim().replace(/^@+/, ""))
    .find((value) => /^[A-Za-z0-9_]{1,15}$/.test(value));

  return {
    userId: userId || null,
    username: username || null,
  };
}

function getReplyParentTweetId(quest: QuestRecord, rules: QuestRules) {
  const rulesRecord = rules as QuestRules & Record<string, unknown>;
  const candidates = [
    rules.parentTweetId,
    rules.replyToTweetId,
    rulesRecord.parent_tweet_id,
    rulesRecord.reply_to_tweet_id,
    String(rulesRecord.parentTweetUrl || ""),
    String(rulesRecord.replyToTweetUrl || ""),
    String(rulesRecord.parent_tweet_url || ""),
    String(rulesRecord.reply_to_tweet_url || ""),
    extractPostId(String(quest.cta_url || "")),
    extractPostId(String(rules.externalUrl || "")),
    quest.slug.toLowerCase().includes("launch")
      ? process.env.DUSTSWAP_LAUNCH_TWEET_ID || ""
      : "",
  ];

  return (
    candidates
      .map((value) => extractPostId(String(value || "")) || String(value || "").trim())
      .find((value) => /^\d+$/.test(value)) || null
  );
}

function includesToken(text: string, expected: string) {
  return text.toLowerCase().includes(expected.toLowerCase());
}

function listMentionCandidates(tweet: any): string[] {
  const mentions = tweet?.entities?.mentions || tweet?.entities?.user_mentions;
  if (!Array.isArray(mentions)) {
    return [];
  }

  return mentions
    .map((item) => item?.username || item?.screen_name || item?.screenName)
    .filter(Boolean)
    .map((value) => normalizeMentionValue(String(value)));
}

function listHashtagCandidates(tweet: any): string[] {
  const hashtags = tweet?.entities?.hashtags;
  if (!Array.isArray(hashtags)) {
    return [];
  }

  return hashtags
    .map((item) => item?.tag || item?.text)
    .filter(Boolean)
    .map((value) => normalizeHashtagValue(String(value)));
}

function matchesRequiredXToken(args: {
  token: string;
  text: string;
  mentionCandidates: string[];
  hashtagCandidates: string[];
  urlCandidates: string[];
}) {
  const normalizedToken = String(args.token || "").trim();
  if (!normalizedToken) {
    return false;
  }

  if (normalizedToken.startsWith("@")) {
    const normalizedMention = normalizeMentionValue(normalizedToken);
    return (
      args.mentionCandidates.includes(normalizedMention) ||
      includesToken(args.text, normalizedToken)
    );
  }

  if (normalizedToken.startsWith("#")) {
    const normalizedHashtag = normalizeHashtagValue(normalizedToken);
    return (
      args.hashtagCandidates.includes(normalizedHashtag) ||
      includesToken(args.text, normalizedToken)
    );
  }

  const lowered = normalizedToken.toLowerCase();
  return (
    includesToken(args.text, lowered) ||
    args.urlCandidates.some((candidate) => candidate.includes(lowered))
  );
}

function listUrlCandidates(tweet: any): string[] {
  const urls = tweet?.entities?.urls;
  if (!Array.isArray(urls)) {
    return [];
  }

  return urls
    .flatMap((item) => [item?.url, item?.expanded_url, item?.display_url])
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
}

async function fetchOpenOceanData<T>(path: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENOCEAN_SWAP_SYNC_TIMEOUT_MS);

  const response = await fetch(`${OPENOCEAN_API_BASE}${path}`, {
    signal: controller.signal,
    headers: {
      Accept: "application/json",
    },
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    throw new Error(`OpenOcean request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    code?: number;
    data?: T;
    error?: string;
    msg?: string;
  };

  if (payload.code && payload.code !== 200) {
    throw new Error(payload.error || payload.msg || "OpenOcean request failed");
  }

  return payload.data as T;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      try {
        results[currentIndex] = {
          status: "fulfilled",
          value: await mapper(items[currentIndex]),
        };
      } catch (error) {
        results[currentIndex] = {
          status: "rejected",
          reason: error,
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
      () => worker()
    )
  );

  return results;
}

export class QuestEngine {
  private readonly manualXUsernameInflight = new Map<
    string,
    {
      usernameKey: string;
      promise: Promise<ManualXUsernameSaveResult>;
    }
  >();

  async listAdminQuests() {
    const { data, error } = await supabase
      .from("quests")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Failed to load quests: ${error.message}`);
    }

    return (data ?? []) as QuestRecord[];
  }

  async saveQuest(input: AdminQuestInput) {
    const payload = {
      id: input.id,
      slug: input.slug.trim(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      campaign_key: normalizeCampaignKey(input.campaignKey),
      category: input.category,
      platform: input.platform,
      action_type: input.actionType,
      verification_type: input.verificationType,
      progress_window: input.progressWindow,
      reward_kind: input.rewardKind || "particle_points",
      reward_points: input.rewardPoints,
      target_value: input.targetValue ?? 1,
      cta_label: input.ctaLabel?.trim() || null,
      cta_url: input.ctaUrl?.trim() || null,
      status: input.status || "draft",
      is_active: input.isActive ?? true,
      sort_order: input.sortOrder ?? 0,
      starts_at: input.startsAt || null,
      ends_at: input.endsAt || null,
      rules: input.rules || {},
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("quests")
      .upsert(payload, {
        onConflict: "slug",
      })
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to save quest: ${error.message}`);
    }

    this.invalidateQuestBoardCache();
    return data as QuestRecord;
  }

  async listCampaignWhitelist(campaignKey: string) {
    const normalizedCampaignKey = normalizeCampaignKey(campaignKey);
    const { data, error } = await supabase
      .from("quest_campaign_whitelist")
      .select("*")
      .eq("campaign_key", normalizedCampaignKey)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Failed to load campaign whitelist: ${error.message}`);
    }

    return (data ?? []) as QuestCampaignWhitelistRecord[];
  }

  async deleteQuest(id: string) {
    const { error } = await supabase.from("quests").delete().eq("id", id);

    if (error) {
      throw new Error(`Failed to delete quest: ${error.message}`);
    }

    this.invalidateQuestBoardCache();
    return { success: true };
  }

  private getQuestBoardCacheKey(address?: string | null) {
    return `quest-board:${normalizeAddress(address || "guest")}`;
  }

  private getSwapSyncCacheKey(address: string) {
    return `quest-swap-sync:${normalizeAddress(address)}`;
  }

  private getManualXUsernameCacheKey(address: string, usernameKey: string) {
    return `quest-manual-x:${normalizeAddress(address)}:${usernameKey}`;
  }

  private buildStartDelayQuestResult(
    questId: string,
    nextVerificationAt?: string | null,
    idempotent = false
  ) {
    return {
      success: true,
      questId,
      nextVerificationAt,
      ...(idempotent ? { idempotent: true } : {}),
    } satisfies StartDelayQuestResult;
  }

  private getStartDelayQuestCacheKey(
    address: string,
    questId: string,
    cycleKey: string
  ) {
    return `quest-start:${normalizeAddress(address)}:${questId}:${cycleKey}`;
  }

  private getStartDelayQuestEarlyCacheKey(address: string, questId: string) {
    return `quest-start:early:${normalizeAddress(address)}:${questId}`;
  }

  private invalidateQuestBoardCache(address?: string | null) {
    if (!address) {
      runtimeCache.invalidatePrefix("quest-board:");
      return;
    }

    runtimeCache.invalidate(this.getQuestBoardCacheKey(address));
  }

  invalidateSwapSyncCache(address?: string | null) {
    if (!address) {
      runtimeCache.invalidatePrefix("quest-swap-sync:");
      return;
    }

    runtimeCache.invalidate(this.getSwapSyncCacheKey(address));
  }

  private async getExistingUserId(address: string) {
    const normalizedAddress = normalizeAddress(address);
    const { data, error } = await supabase
      .from("users")
      .select("id")
      .eq("address", normalizedAddress)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load quest user: ${error.message}`);
    }

    return data ? Number((data as { id: number }).id) : null;
  }

  private async assertAuthenticatedXAccountAction(
    input: XAccountAuthInput,
    expectedAction: "connect-x" | "disconnect-x"
  ) {
    if (!input.address || !input.message || !input.signature) {
      throw new Error("address, message, and signature are required");
    }

    if (!isAddress(input.address)) {
      throw new Error("A valid wallet address is required");
    }

    const normalizedAddress = getAddress(input.address).toLowerCase();
    const parsed = parseXAccountMessage(input.message);
    const messageAddress = getAddress(parsed.address).toLowerCase();

    if (messageAddress !== normalizedAddress) {
      throw new Error("X connection signature address mismatch");
    }

    if (parsed.action !== expectedAction) {
      throw new Error("Invalid X connection action");
    }

    if (!parsed.domain || !isAllowedAppDomain(parsed.domain)) {
      throw new Error("Unexpected X connection domain");
    }

    if (!parsed.nonce || parsed.nonce.length < 8 || parsed.nonce.length > 128) {
      throw new Error("Invalid X connection nonce");
    }

    const timestampMs = Date.parse(parsed.timestamp);
    if (!Number.isFinite(timestampMs)) {
      throw new Error("Invalid X connection timestamp");
    }

    const now = Date.now();
    if (now - timestampMs > 5 * 60 * 1000) {
      throw new Error("Expired X connection signature");
    }

    if (timestampMs - now > 60 * 1000) {
      throw new Error("Invalid X connection timestamp");
    }

    const replayKey = `x-account:replay:${createHash("sha256")
      .update(`${input.message}|${input.signature.toLowerCase()}`)
      .digest("hex")}`;

    if (runtimeCache.get(replayKey)) {
      throw new Error("X connection signature was already used");
    }

    const valid = await publicClient.verifyMessage({
      address: normalizedAddress as `0x${string}`,
      message: input.message,
      signature: input.signature,
    });

    if (!valid) {
      throw new Error("Invalid X connection signature");
    }

    runtimeCache.set(replayKey, true, 5 * 60 * 1000);
    return normalizedAddress;
  }

  private async storeXOAuthState(args: {
    state: string;
    userId: number;
    address: string;
    returnTo: string;
    codeVerifier: string;
  }) {
    const stateHash = hashOAuthState(args.state);
    const expiresAt = new Date(Date.now() + X_OAUTH_STATE_TTL_MS).toISOString();
    const cached = {
      userId: args.userId,
      address: args.address,
      returnTo: args.returnTo,
      codeVerifier: args.codeVerifier,
      expiresAt,
    };

    try {
      const { error } = await supabase.from("oauth_states").insert({
        state_hash: stateHash,
        platform: "x",
        user_id: args.userId,
        wallet_address: args.address,
        return_to: args.returnTo,
        code_verifier: args.codeVerifier,
        expires_at: expiresAt,
      });

      if (error) {
        throw new Error(error.message);
      }
    } catch (error) {
      console.warn("[X OAuth] Falling back to runtime OAuth state cache:", error);
      runtimeCache.set(getOAuthStateCacheKey(stateHash), cached, X_OAUTH_STATE_CACHE_TTL_MS);
    }
  }

  private async consumeXOAuthState(state: string) {
    const stateHash = hashOAuthState(state);
    const cacheKey = getOAuthStateCacheKey(stateHash);
    const cached = runtimeCache.get<{
      userId: number;
      address: string;
      returnTo: string;
      codeVerifier: string;
      expiresAt: string;
    }>(cacheKey);

    if (cached) {
      runtimeCache.invalidate(cacheKey);
      if (Date.now() > new Date(cached.expiresAt).getTime()) {
        throw new Error("X auth session expired, please try again");
      }

      return cached;
    }

    const { data, error } = await supabase
      .from("oauth_states")
      .select("*")
      .eq("state_hash", stateHash)
      .eq("platform", "x")
      .is("consumed_at", null)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load X auth state: ${error.message}`);
    }

    const row = data as
      | {
          user_id: number;
          wallet_address: string;
          return_to: string;
          code_verifier: string;
          expires_at: string;
        }
      | null;

    if (!row) {
      throw new Error("Invalid or already used X auth state");
    }

    if (Date.now() > new Date(row.expires_at).getTime()) {
      throw new Error("X auth session expired, please try again");
    }

    const { error: consumeError } = await supabase
      .from("oauth_states")
      .update({ consumed_at: new Date().toISOString() })
      .eq("state_hash", stateHash)
      .eq("platform", "x")
      .is("consumed_at", null);

    if (consumeError) {
      throw new Error(`Failed to consume X auth state: ${consumeError.message}`);
    }

    return {
      userId: Number(row.user_id),
      address: normalizeAddress(row.wallet_address),
      returnTo: normalizeReturnTo(row.return_to),
      codeVerifier: row.code_verifier,
      expiresAt: row.expires_at,
    };
  }

  async getQuestBoard(address?: string) {
    const normalizedAddress = address ? normalizeAddress(address) : null;
    const cacheKey = this.getQuestBoardCacheKey(normalizedAddress);

    return runtimeCache.getOrSet(cacheKey, QUEST_BOARD_CACHE_TTL_MS, async () => {
      const now = getNow();
      const { data: questsData, error: questsError } = await supabase
        .from("quests")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (questsError) {
        throw new Error(`Failed to load quest board: ${questsError.message}`);
      }

      const quests = ((questsData ?? []) as QuestRecord[]).filter((quest) =>
        isQuestLive(quest, now)
      );

      let linkedAccounts: Record<string, unknown> = {};
      let progressByKey = new Map<string, QuestProgressRecord>();
      let campaignWhitelistByKey = new Map<string, QuestCampaignWhitelistRecord>();

      if (normalizedAddress) {
        const userId = await this.getExistingUserId(normalizedAddress);

        if (userId) {
          const [{ data: socialData, error: socialError }, { data: progressRows, error: progressError }, { data: whitelistRows, error: whitelistError }] =
            await Promise.all([
              supabase.from("social_accounts").select("*").eq("user_id", userId),
              supabase.from("quest_progress").select("*").eq("user_id", userId),
              supabase.from("quest_campaign_whitelist").select("*").eq("user_id", userId),
            ]);

          if (socialError) {
            throw new Error(`Failed to load linked quest accounts: ${socialError.message}`);
          }

          if (progressError) {
            throw new Error(`Failed to load quest progress: ${progressError.message}`);
          }

          if (whitelistError) {
            throw new Error(`Failed to load campaign whitelist: ${whitelistError.message}`);
          }

          linkedAccounts = Object.fromEntries(
            ((socialData ?? []) as SocialAccountRecord[]).map((account) => [
              account.platform,
              account.platform === "x"
                ? toXAccountSummary(account as unknown as XSocialAccountRecord)
                : {
                    username: account.username,
                    platformUserId: account.platform_user_id,
                    displayName: account.display_name,
                    profileImageUrl: account.profile_image_url,
                    connected: true,
                  },
            ])
          );

          progressByKey = new Map(
            ((progressRows ?? []) as QuestProgressRecord[]).map((row) => [
              `${row.quest_id}:${row.cycle_key}`,
              row,
            ])
          );

          campaignWhitelistByKey = new Map(
            ((whitelistRows ?? []) as QuestCampaignWhitelistRecord[]).map((row) => [
              normalizeCampaignKey(row.campaign_key),
              row,
            ])
          );
        }
      }

      const questItems = quests.map((quest) => {
        const cycleKey = getCycleKey(quest.progress_window, now);
        const progress = progressByKey.get(`${quest.id}:${cycleKey}`) ?? null;

        return {
          id: quest.id,
          slug: quest.slug,
          title: quest.title,
          description: quest.description,
          campaignKey: normalizeCampaignKey(quest.campaign_key),
          category: quest.category,
          platform: quest.platform,
          actionType: quest.action_type,
          verificationType: quest.verification_type,
          progressWindow: quest.progress_window,
          rewardKind: quest.reward_kind,
          rewardPoints: quest.reward_points,
          targetValue: quest.target_value,
          ctaLabel: quest.cta_label,
          ctaUrl: quest.cta_url,
          rules: safeRules(quest.rules),
          endsAt: quest.ends_at,
          progress: progress
            ? {
                status: progress.status,
                value: progress.progress,
                targetValue: progress.target_value,
                verificationAttempts: progress.verification_attempts,
                nextVerificationAt: progress.next_verification_at,
                openedAt: progress.opened_at,
                completedAt: progress.completed_at,
              }
            : null,
        };
      });

      const campaigns = this.buildCampaignSummaries(
        quests,
        progressByKey,
        campaignWhitelistByKey,
        now
      );

      return {
        linkedAccounts,
        campaigns,
        quests: questItems,
        serverTime: now.toISOString(),
      };
    });
  }

  async getXAccount(address: string) {
    if (!isAddress(address)) {
      throw new Error("A valid wallet address is required");
    }

    const normalizedAddress = normalizeAddress(address);
    const userId = await this.getExistingUserId(normalizedAddress);
    if (!userId) {
      return {
        success: true,
        account: null,
      } as const;
    }

    return {
      success: true,
      account: await xVerificationService.getAccountSummary(userId),
    } as const;
  }

  async saveManualXUsername(address: string, username: string) {
    if (!isAddress(address)) {
      throw new Error("A valid wallet address is required");
    }

    const normalizedAddress = normalizeAddress(address);
    const normalizedUsername = normalizeXUsernameInput(username);
    const cacheKey = this.getManualXUsernameCacheKey(
      normalizedAddress,
      normalizedUsername.key
    );
    const recent = runtimeCache.get<{ success: true; username: string }>(cacheKey);

    if (recent) {
      return recent;
    }

    while (true) {
      const inflight = this.manualXUsernameInflight.get(normalizedAddress);
      if (!inflight) {
        break;
      }

      if (inflight.usernameKey === normalizedUsername.key) {
        return inflight.promise;
      }

      try {
        await inflight.promise;
      } catch {
        // Continue and let the new request run after the previous save settles.
      }

      const cachedAfterWait = runtimeCache.get<ManualXUsernameSaveResult>(cacheKey);
      if (cachedAfterWait) {
        return cachedAfterWait;
      }
    }

    const request = this.saveManualXUsernameOnce(
      normalizedAddress,
      normalizedUsername
    ).finally(() => {
      const current = this.manualXUsernameInflight.get(normalizedAddress);
      if (current?.promise === request) {
        this.manualXUsernameInflight.delete(normalizedAddress);
      }
    });

    this.manualXUsernameInflight.set(normalizedAddress, {
      usernameKey: normalizedUsername.key,
      promise: request,
    });

    return request;
  }

  private async saveManualXUsernameOnce(
    normalizedAddress: string,
    normalizedUsername: ReturnType<typeof normalizeXUsernameInput>
  ) {
    const cacheKey = this.getManualXUsernameCacheKey(
      normalizedAddress,
      normalizedUsername.key
    );
    const user = await pointsEngine.getOrCreate(normalizedAddress);
    const { data: existingAccount, error: existingAccountError } = await supabase
      .from("social_accounts")
      .select("user_id, platform, platform_user_id, username")
      .eq("user_id", user.id)
      .eq("platform", "x")
      .maybeSingle();

    if (existingAccountError) {
      throw new Error(`Failed to load linked X username: ${existingAccountError.message}`);
    }

    if (existingAccount) {
      const linkedKeys = getNormalizedLinkedXKeys(existingAccount as SocialAccountRecord);
      if (linkedKeys.includes(normalizedUsername.key)) {
        const result = {
          success: true,
          username: normalizedUsername.display,
        } as const;

        runtimeCache.set(cacheKey, result, MANUAL_X_USERNAME_DEDUPE_TTL_MS);
        return result;
      }
    }

    const { data: existingUsername, error: existingUsernameError } = await supabase
      .from("social_accounts")
      .select("user_id")
      .eq("platform", "x")
      .eq("platform_user_id", normalizedUsername.key)
      .maybeSingle();

    if (existingUsernameError) {
      throw new Error(`Failed to check X username: ${existingUsernameError.message}`);
    }

    if (existingUsername && existingUsername.user_id !== user.id) {
      throw new Error("That X username is already linked to another wallet");
    }

    const { error } = await supabase.from("social_accounts").upsert(
      {
        user_id: user.id,
        platform: "x",
        platform_user_id: normalizedUsername.key,
        username: normalizedUsername.display,
        display_name: null,
        profile_image_url: null,
        access_token: null,
        refresh_token: null,
        scope: null,
        token_expires_at: null,
        metadata: {
          linkedAt: new Date().toISOString(),
          linkedManually: true,
        },
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "user_id,platform",
      }
    );

    if (error) {
      throw new Error(`Failed to save X username: ${error.message}`);
    }

    const result = {
      success: true,
      username: normalizedUsername.display,
    } as const;

    runtimeCache.set(cacheKey, result, MANUAL_X_USERNAME_DEDUPE_TTL_MS);
    this.invalidateQuestBoardCache(normalizedAddress);
    return result;
  }

  async createXAuthUrl(input: XAccountAuthInput) {
    const normalizedAddress = await this.assertAuthenticatedXAccountAction(
      input,
      "connect-x"
    );
    const returnTo = normalizeReturnTo(input.returnTo);
    const user = await pointsEngine.getOrCreate(normalizedAddress);
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const redirectUri = getXRedirectUri();

    const state = randomBytes(32).toString("base64url");
    await this.storeXOAuthState({
      state,
      userId: user.id,
      address: normalizedAddress,
      returnTo,
      codeVerifier,
    });

    const url = new URL("https://x.com/i/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", getXClientId());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", X_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return url.toString();
  }

  async handleXCallback(code: string, state: string) {
    const payload = await this.consumeXOAuthState(state);

    const tokenBody = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: getXClientId(),
      redirect_uri: getXRedirectUri(),
      code_verifier: payload.codeVerifier,
    });

    const tokenHeaders: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const clientSecret = getXClientSecret();
    if (clientSecret) {
      tokenHeaders.Authorization = `Basic ${Buffer.from(
        `${getXClientId()}:${clientSecret}`
      ).toString("base64")}`;
    }

    const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: tokenHeaders,
      body: tokenBody.toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Failed to exchange X auth code: ${errorText}`);
    }

    const tokenJson = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      scope?: string;
      expires_in?: number;
    };

    const meUrl = new URL("https://api.x.com/2/users/me");
    meUrl.searchParams.set("user.fields", "profile_image_url");

    const meResponse = await fetch(meUrl, {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
      },
    });

    if (!meResponse.ok) {
      const errorText = await meResponse.text();
      throw new Error(`Failed to fetch X profile: ${errorText}`);
    }

    const meJson = (await meResponse.json()) as {
      data?: {
        id: string;
        username: string;
        name?: string;
        profile_image_url?: string;
      };
    };

    if (!meJson.data?.id) {
      throw new Error("X profile lookup returned no user");
    }

    const tokenExpiresAt = tokenJson.expires_in
      ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
      : null;

    const normalizedUsername = normalizeXUsernameInput(meJson.data.username);
    const connectedAt = new Date().toISOString();

    const { error } = await supabase
      .from("social_accounts")
      .upsert(
        {
          user_id: payload.userId,
          platform: "x",
          platform_user_id: meJson.data.id,
          username: normalizedUsername.key,
          display_name: meJson.data.name || null,
          profile_image_url: meJson.data.profile_image_url || null,
          access_token: X_STORE_OAUTH_TOKENS ? tokenJson.access_token : null,
          refresh_token: X_STORE_OAUTH_TOKENS ? tokenJson.refresh_token || null : null,
          scope: tokenJson.scope || X_SCOPES.join(" "),
          token_expires_at: tokenExpiresAt,
          metadata: {
            linkedAt: connectedAt,
            connectedAt,
            oauthConnected: true,
            xConnected: true,
            xUserId: meJson.data.id,
            username: normalizedUsername.key,
            tokenStorage: X_STORE_OAUTH_TOKENS ? "database" : "discarded",
          },
          updated_at: connectedAt,
        },
        {
          onConflict: "user_id,platform",
        }
      );

    if (error) {
      throw new Error(`Failed to save X account: ${error.message}`);
    }

    const { error: userUpdateError } = await supabase
      .from("users")
      .update({
        x_user_id: meJson.data.id,
        x_username: normalizedUsername.key,
        x_name: meJson.data.name || null,
        x_avatar: meJson.data.profile_image_url || null,
        x_connected: true,
        x_connected_at: connectedAt,
        updated_at: connectedAt,
      })
      .eq("id", payload.userId);

    if (userUpdateError) {
      throw new Error(`Failed to save X account on user: ${userUpdateError.message}`);
    }

    xVerificationService.invalidateForXUser(meJson.data.id);
    pointsEngine.invalidateUserReadCaches(payload.address);

    return {
      address: payload.address,
      returnTo: payload.returnTo,
      username: normalizedUsername.key,
      xUserId: meJson.data.id,
    };
  }

  async disconnectXAccount(input: XAccountAuthInput) {
    const normalizedAddress = await this.assertAuthenticatedXAccountAction(
      input,
      "disconnect-x"
    );
    const userId = await this.getExistingUserId(normalizedAddress);
    if (!userId) {
      return {
        success: true,
        disconnected: true,
        account: null,
      } as const;
    }

    const { data: accountData, error: accountError } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", userId)
      .eq("platform", "x")
      .maybeSingle();

    if (accountError) {
      throw new Error(`Failed to load X account: ${accountError.message}`);
    }

    const account = (accountData as XSocialAccountRecord | null) ?? null;
    const xUserId = account ? getConnectedXUserId(account) : null;
    const disconnectedAt = new Date().toISOString();

    if (account) {
      const metadata =
        account.metadata && typeof account.metadata === "object" && !Array.isArray(account.metadata)
          ? account.metadata
          : {};
      const { error } = await supabase
        .from("social_accounts")
        .update({
          platform_user_id: `disconnected:${userId}:${Date.now()}`,
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          metadata: {
            ...metadata,
            previousPlatformUserId: account.platform_user_id,
            previousXUserId: xUserId,
            oauthConnected: false,
            xConnected: false,
            disconnectedAt,
          },
          updated_at: disconnectedAt,
        })
        .eq("id", account.id);

      if (error) {
        throw new Error(`Failed to disconnect X account: ${error.message}`);
      }
    }

    const { error: userUpdateError } = await supabase
      .from("users")
      .update({
        x_user_id: null,
        x_connected: false,
        x_connected_at: null,
        updated_at: disconnectedAt,
      })
      .eq("id", userId);

    if (userUpdateError) {
      throw new Error(`Failed to update disconnected X user state: ${userUpdateError.message}`);
    }

    xVerificationService.invalidateForXUser(xUserId);
    this.invalidateQuestBoardCache(normalizedAddress);
    pointsEngine.invalidateUserReadCaches(normalizedAddress);

    return {
      success: true,
      disconnected: true,
      account: null,
    } as const;
  }

  async startDelayQuest(address: string, questId: string) {
    const normalizedAddress = normalizeAddress(address);
    const earlyCacheKey = this.getStartDelayQuestEarlyCacheKey(
      normalizedAddress,
      questId
    );
    const earlyRecent = runtimeCache.get<StartDelayQuestResult>(earlyCacheKey);

    if (earlyRecent) {
      return {
        ...earlyRecent,
        idempotent: true,
      };
    }

    return runtimeCache.singleFlight(`${earlyCacheKey}:inflight`, async () => {
      const cachedDuringFlight = runtimeCache.get<StartDelayQuestResult>(earlyCacheKey);

      if (cachedDuringFlight) {
        return {
          ...cachedDuringFlight,
          idempotent: true,
        };
      }

      const quest = await this.getQuestById(questId);
      const rules = safeRules(quest.rules);
      const now = getNow();
      const cycleKey = getCycleKey(quest.progress_window, now);
      const cacheKey = this.getStartDelayQuestCacheKey(
        normalizedAddress,
        quest.id,
        cycleKey
      );
      const recent = runtimeCache.get<StartDelayQuestResult>(cacheKey);

      if (recent) {
        runtimeCache.set(
          earlyCacheKey,
          recent,
          START_DELAY_QUEST_DEDUPE_TTL_MS
        );
        return {
          ...recent,
          idempotent: true,
        };
      }

      const existingUserId = await this.getExistingUserId(normalizedAddress);
      if (existingUserId) {
        const existingProgress = await this.getProgress(existingUserId, quest.id, cycleKey);
        if (
          existingProgress &&
          existingProgress.status !== "not_started" &&
          (existingProgress.opened_at ||
            existingProgress.next_verification_at ||
            existingProgress.completed_at)
        ) {
          const existingResult = this.buildStartDelayQuestResult(
            quest.id,
            existingProgress.next_verification_at,
            true
          );

          runtimeCache.set(cacheKey, existingResult, START_DELAY_QUEST_DEDUPE_TTL_MS);
          runtimeCache.set(
            earlyCacheKey,
            existingResult,
            START_DELAY_QUEST_DEDUPE_TTL_MS
          );
          return existingResult;
        }
      }

      const userId =
        existingUserId ?? (await pointsEngine.getOrCreate(normalizedAddress)).id;

      if (quest.platform === "x") {
        await this.assertLinkedSocialAccount(userId, "x");
      }

      const delaySeconds =
        quest.platform === "x" && quest.action_type === "follow"
          ? 0
          : toNumber(rules.delaySeconds, 20);
      const nowIso = now.toISOString();
      const result = await runtimeCache.singleFlight(`${cacheKey}:inflight`, async () => {
        const existing = await this.getProgress(userId, quest.id, cycleKey);
        if (
          existing &&
          existing.status !== "not_started" &&
          (existing.opened_at || existing.next_verification_at || existing.completed_at)
        ) {
          return this.buildStartDelayQuestResult(
            quest.id,
            existing.next_verification_at,
            true
          );
        }

        const progress = await this.upsertProgress({
          userId,
          quest,
          cycleKey,
          existing,
          updates: {
            status: "in_progress",
            opened_at: nowIso,
            next_verification_at: new Date(
              now.getTime() + delaySeconds * 1000
            ).toISOString(),
          },
        });

        this.invalidateQuestBoardCache(normalizedAddress);
        return this.buildStartDelayQuestResult(
          quest.id,
          progress.next_verification_at
        );
      });

      runtimeCache.set(cacheKey, result, START_DELAY_QUEST_DEDUPE_TTL_MS);
      runtimeCache.set(
        earlyCacheKey,
        result,
        START_DELAY_QUEST_DEDUPE_TTL_MS
      );
      return result;
    });
  }

  async verifyDelayQuest(address: string, questId: string) {
    const quest = await this.getQuestById(questId);
    const rules = safeRules(quest.rules);
    const user = await pointsEngine.getOrCreate(address);
    const normalizedAddress = normalizeAddress(address);

    if (quest.platform === "x") {
      await this.assertLinkedSocialAccount(user.id, "x");
    }

    const cycleKey = getCycleKey(quest.progress_window, getNow());
    let progress = await this.getProgress(user.id, quest.id, cycleKey);

    if (quest.platform === "x" && quest.action_type === "follow") {
      const connectedAccount = await xVerificationService.requireConnectedAccount(user.id);
      const target = getTargetXUserRef(quest, rules);
      if (!target.userId && !target.username) {
        throw new Error("This follow quest is missing an X target account");
      }

      const nowIso = new Date().toISOString();
      if (!progress) {
        progress = await this.upsertProgress({
          userId: user.id,
          quest,
          cycleKey,
          updates: {
            status: "in_progress",
            progress: 0,
            target_value: quest.target_value,
            opened_at: nowIso,
            next_verification_at: nowIso,
          },
        });
      }

      const followCheck = await xVerificationService.checkFollowRelationship(
        {
          userId: connectedAccount.xUserId,
          username: connectedAccount.username,
        },
        target
      );

      if (!followCheck.verified) {
        const updated = await this.upsertProgress({
          userId: user.id,
          quest,
          cycleKey,
          existing: progress,
          updates: {
            status: "in_progress",
            verification_attempts: progress.verification_attempts + 1,
            verified_by_api: false,
            verified_at: nowIso,
            metadata: {
              ...(progress.metadata || {}),
              verified_by_api: false,
              verified_at: nowIso,
              verification_provider: "getx",
              target_x_user_id: followCheck.targetUser.id,
              target_x_username: followCheck.targetUser.userName,
              source_x_user_id: connectedAccount.xUserId,
            },
          },
        });

        await this.logVerificationAttempt(
          user.id,
          quest.id,
          cycleKey,
          "failed",
          {
            verificationType: quest.verification_type,
            actionType: quest.action_type,
            sourceXUserId: connectedAccount.xUserId,
            targetXUserId: followCheck.targetUser.id,
          },
          {
            verifiedByApi: false,
            sourceFollowsTarget: followCheck.raw?.sourceFollowsTarget === true,
            attempts: updated.verification_attempts,
          }
        );

        this.invalidateQuestBoardCache(normalizedAddress);
        return {
          success: false,
          status: "not_following",
          error: `Follow @${followCheck.targetUser.userName}, then verify again.`,
        };
      }

      const completed = await this.completeQuest(
        user.id,
        normalizedAddress,
        quest,
        cycleKey,
        {
          verificationType: quest.verification_type,
          verification_provider: "getx",
          verified_by_api: true,
          verified_at: nowIso,
          source_x_user_id: connectedAccount.xUserId,
          source_x_username: followCheck.sourceUser.userName,
          target_x_user_id: followCheck.targetUser.id,
          target_x_username: followCheck.targetUser.userName,
        }
      );

      await this.logVerificationAttempt(
        user.id,
        quest.id,
        cycleKey,
        "completed",
        {
          verificationType: quest.verification_type,
          actionType: quest.action_type,
          sourceXUserId: connectedAccount.xUserId,
          targetXUserId: followCheck.targetUser.id,
        },
        {
          verifiedByApi: true,
          rewardedPoints: completed.awardedPoints,
        }
      );

      this.invalidateQuestBoardCache(normalizedAddress);
      return {
        success: true,
        status: "completed",
        awardedPoints: completed.awardedPoints,
      };
    }

    if (!progress?.next_verification_at) {
      throw new Error("Open the quest first before verifying");
    }

    const now = getNow();
    const verifyAt = new Date(progress.next_verification_at);

    if (now < verifyAt) {
      return {
        success: false,
        status: "cooldown",
        remainingSeconds: Math.ceil((verifyAt.getTime() - now.getTime()) / 1000),
      };
    }

    const completed = await this.completeQuest(
      user.id,
      normalizedAddress,
      quest,
      cycleKey,
      {
        verificationType: quest.verification_type,
      }
    );

    await this.logVerificationAttempt(
      user.id,
      quest.id,
      cycleKey,
      "completed",
      { verificationType: quest.verification_type },
      { rewardedPoints: completed.awardedPoints }
    );

    this.invalidateQuestBoardCache(normalizedAddress);
    return {
      success: true,
      status: "completed",
      awardedPoints: completed.awardedPoints,
    };
  }

  async verifyXPost(address: string, questId: string, postUrl: string) {
    const quest = await this.getQuestById(questId);
    const rules = safeRules(quest.rules);
    const user = await pointsEngine.getOrCreate(address);
    const now = getNow();
    const cycleKey = getCycleKey(quest.progress_window, now);
    const connectedAccount = await xVerificationService.requireConnectedAccount(user.id);

    const postId = extractPostId(postUrl);
    if (!postId) {
      throw new Error(
        quest.action_type === "reply"
          ? "Enter a valid X reply link"
          : "Enter a valid X post link"
      );
    }

    await this.upsertProgress({
      userId: user.id,
      quest,
      cycleKey,
      updates: {
        status: "in_progress",
        progress: 0,
        target_value: quest.target_value,
        opened_at: now.toISOString(),
      },
    });

    let tweet: Awaited<ReturnType<typeof xVerificationService.getTweetDetail>>;
    try {
      tweet = await xVerificationService.getTweetDetail(postId);
    } catch (error) {
      await this.logVerificationAttempt(
        user.id,
        quest.id,
        cycleKey,
        "failed",
        { postUrl },
        { error: (error as Error).message }
      );
      throw new Error("We could not read that X post. Check the link and try again.");
    }

    const authorId = String(tweet.author?.id || tweet.author_id || "").trim();
    const authorUsername = String(tweet.author?.userName || "").trim();
    if (!tweet?.id || !authorId || !tweet.text) {
      throw new Error("That X post is missing required data for verification");
    }

    if (authorId !== connectedAccount.xUserId) {
      const enteredUsername = connectedAccount.username
        ? getLinkedXUsernameDisplay({
            id: connectedAccount.id,
            user_id: connectedAccount.userId,
            platform: "x",
            platform_user_id: connectedAccount.xUserId,
            username: connectedAccount.username,
            display_name: connectedAccount.displayName,
            profile_image_url: connectedAccount.avatarUrl,
            access_token: null,
            refresh_token: null,
            scope: null,
            token_expires_at: null,
            metadata: null,
          })
        : "your connected X account";
      throw new Error(
        `X account mismatch. Kindly post from ${enteredUsername} and try again.`
      );
    }

    let parentTweetId: string | null = null;
    if (quest.action_type === "reply") {
      parentTweetId = getReplyParentTweetId(quest, rules);
      if (!parentTweetId) {
        throw new Error("This reply quest is missing the target X post link");
      }

      const directParentId = String(tweet.inReplyToId || "").trim();
      const conversationId = String(tweet.conversationId || "").trim();
      const isCorrectReply =
        tweet.isReply === true &&
        (directParentId === parentTweetId ||
          (!directParentId && conversationId === parentTweetId));

      if (!isCorrectReply) {
        throw new Error("That link is not a reply to the required X post.");
      }
    }

    const text = tweet.text;
    const requiredMention = String(rules.requiredMention || "").trim();
    const requiredMentionsAny = Array.isArray(rules.requiredMentionsAny)
      ? rules.requiredMentionsAny.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const requiredAnyOf = Array.isArray(rules.requiredAnyOf)
      ? rules.requiredAnyOf.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const requiredHashtags = Array.isArray(rules.requiredHashtags)
      ? rules.requiredHashtags.map((value) => String(value))
      : [];
    const requiredLinks = Array.isArray(rules.requiredLinks)
      ? rules.requiredLinks.map((value) => String(value))
      : [];
    const urlCandidates = listUrlCandidates(tweet);
    const mentionCandidates = listMentionCandidates(tweet);
    const hashtagCandidates = listHashtagCandidates(tweet);
    const fallbackAnyOf = [
      ...requiredAnyOf,
      ...requiredMentionsAny,
      ...requiredHashtags,
      ...(requiredMention ? [requiredMention] : []),
    ].filter(Boolean);

    if (fallbackAnyOf.length > 0) {
      const matchedAnyOf = fallbackAnyOf.some((token) =>
        matchesRequiredXToken({
          token,
          text,
          mentionCandidates,
          hashtagCandidates,
          urlCandidates,
        })
      );

      if (!matchedAnyOf) {
        throw new Error(
          `Required # or @ not found. Kindly add ${fallbackAnyOf.join(" ")} at least one.`
        );
      }
    }

    for (const link of requiredLinks) {
      const normalized = link.toLowerCase();
      const matched =
        includesToken(text, normalized) ||
        urlCandidates.some((candidate) => candidate.includes(normalized));
      if (!matched) {
        throw new Error(`Your post must include ${link}`);
      }
    }

    const completed = await this.completeQuest(
      user.id,
      normalizeAddress(address),
      quest,
      cycleKey,
      {
        postId,
        postUrl,
        parentTweetId,
        authorId,
        authorUsername,
        verification_provider: "getx",
        verified_by_api: true,
        verified_at: now.toISOString(),
      }
    );

    await this.logVerificationAttempt(
      user.id,
      quest.id,
      cycleKey,
      "completed",
      { postUrl },
      {
        postId,
        parentTweetId,
        authorId,
        authorUsername,
        verifiedByApi: true,
        rewardedPoints: completed.awardedPoints,
      }
    );

    this.invalidateQuestBoardCache(address);
    return {
      success: true,
      status: "completed",
      postId,
      parentTweetId,
      awardedPoints: completed.awardedPoints,
    };
  }

  async syncRecentSwapActivity(address: string, options?: { force?: boolean }) {
    if (!isAddress(address)) {
      throw new Error("A valid wallet address is required");
    }

    const normalizedAddress = normalizeAddress(address);
    const cacheKey = this.getSwapSyncCacheKey(normalizedAddress);
    const force = options?.force ?? false;

    const runSync = async () => {
      const user = await pointsEngine.getOrCreate(normalizedAddress);
      const knownSwaps = await this.getKnownSwapAmounts(user.id, base.id);

      const params = new URLSearchParams({
        account: normalizedAddress,
        pageSize: String(OPENOCEAN_SWAP_SYNC_PAGE_SIZE),
      });

      let history: OpenOceanWalletTransaction[] = [];
      try {
        history =
          (await fetchOpenOceanData<OpenOceanWalletTransaction[]>(
            `/base/getTxs?${params.toString()}`
          )) || [];
      } catch {
        history = [];
      }

      const candidateSwaps = Array.from(
        (history ?? [])
          .slice(0, OPENOCEAN_SWAP_SYNC_MAX_RECORDS)
          .reduce((itemsByHash, item) => {
            const txHash = item.txHash?.toLowerCase();
            if (txHash && !itemsByHash.has(txHash)) {
              itemsByHash.set(txHash, {
                txHash,
                amountUsd: item.usd_valuation,
              });
            }

            return itemsByHash;
          }, new Map<string, { txHash: string; amountUsd?: number | string }>())
          .values()
      ).filter((item) => !knownSwaps.has(getSwapTransactionKey(base.id, item.txHash)));

      const importedHashes: string[] = [];
      const currentReferenceDate = getNow();
      const syncReferenceDates = new Map<string, Date>([
        [currentReferenceDate.toISOString(), currentReferenceDate],
      ]);
      const recordResults = await mapWithConcurrency(
        candidateSwaps,
        OPENOCEAN_SWAP_SYNC_CONCURRENCY,
        async (item) =>
          recordSwap({
            address: normalizedAddress,
            txHash: item.txHash,
            chainId: base.id,
            trustedOpenOceanAmountUsd: item.amountUsd,
          })
      );

      for (const result of recordResults) {
        if (result.status !== "fulfilled") {
          // Ignore individual lookup failures so one bad tx does not block all sync.
          continue;
        }

        const recorded = result.value;
        knownSwaps.set(
          getSwapTransactionKey(base.id, recorded.txHash),
          recorded.amountUsd
        );

        if (recorded.isNew) {
          importedHashes.push(recorded.txHash);
          const referenceDate = getReferenceDateFromDayKey(recorded.dayKey);
          if (referenceDate) {
            syncReferenceDates.set(referenceDate.toISOString(), referenceDate);
          }
        }
      }

      const completedQuests = await this.syncPublishedSwapQuests(
        user.id,
        normalizedAddress,
        Array.from(syncReferenceDates.values())
      );

      if (importedHashes.length > 0 || completedQuests.length > 0) {
        pointsEngine.invalidateUserReadCaches(normalizedAddress);
      }

      this.invalidateQuestBoardCache(normalizedAddress);

      return {
        success: true,
        importedHashes,
        completedQuests,
      };
    };

    if (force) {
      const result = await runSync();
      runtimeCache.set(cacheKey, result, SWAP_SYNC_DEDUPE_TTL_MS);
      return result;
    }

    return runtimeCache.getOrSet(cacheKey, SWAP_SYNC_DEDUPE_TTL_MS, runSync);
  }

  async recordSwapActivity(input: SwapActivityInput) {
    if (!isAddress(input.address)) {
      throw new Error("A valid wallet address is required");
    }

    if (!input.txHash) {
      throw new Error("Transaction hash is required");
    }

    if (!Number.isFinite(input.chainId)) {
      throw new Error("A valid chainId is required");
    }

    const normalizedAddress = normalizeAddress(input.address);
    await recordSwap({
      address: normalizedAddress,
      txHash: input.txHash,
      chainId: input.chainId,
    });

    pointsEngine.invalidateUserReadCaches(normalizedAddress);
    this.invalidateSwapSyncCache(normalizedAddress);
    const questSync = await this.syncRecordedSwapProgress(normalizedAddress);

    this.invalidateQuestBoardCache(normalizedAddress);
    return {
      success: true,
      completedQuests: questSync.completedQuests,
    };
  }

  async syncRecordedSwapProgress(address: string) {
    if (!isAddress(address)) {
      throw new Error("A valid wallet address is required");
    }

    const normalizedAddress = normalizeAddress(address);
    const user = await pointsEngine.getOrCreate(normalizedAddress);
    const completedQuests = await this.syncPublishedSwapQuests(user.id, normalizedAddress);

    if (completedQuests.length > 0) {
      pointsEngine.invalidateUserReadCaches(normalizedAddress);
    }
    this.invalidateQuestBoardCache(normalizedAddress);

    return {
      success: true,
      completedQuests,
    };
  }

  private async getKnownSwapAmounts(userId: number, chainId?: number) {
    let query = supabase
      .from("swap_transactions")
      .select("chain_id, tx_hash, amount_usd")
      .eq("user_id", userId);

    if (Number.isFinite(chainId)) {
      query = query.eq("chain_id", Number(chainId));
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to load existing swap transactions: ${error.message}`);
    }

    return new Map(
      (data ?? []).map((row) => [
        getSwapTransactionKey(
          Number((row as { chain_id: number }).chain_id),
          String((row as { tx_hash: string }).tx_hash)
        ),
        toNumber((row as { amount_usd: number }).amount_usd),
      ])
    );
  }

  private async syncPublishedSwapQuests(
    userId: number,
    address: string,
    referenceDates: Date[] = [getNow()]
  ) {
    const { data: questsData, error: questsError } = await supabase
      .from("quests")
      .select("*")
      .eq("category", "onchain")
      .in("action_type", ["swap_volume", "swap_count"])
      .eq("status", "published")
      .eq("is_active", true);

    if (questsError) {
      throw new Error(`Failed to load swap quests: ${questsError.message}`);
    }

    const completedQuests: Array<{
      questId: string;
      slug: string;
      awardedPoints: number;
    }> = [];

    const now = getNow();
    const quests = ((questsData ?? []) as QuestRecord[]).filter((quest) =>
      isQuestLive(quest, now)
    );

    for (const quest of quests) {
      const seenCycleKeys = new Set<string>();

      for (const referenceDate of referenceDates) {
        const cycleKey = getCycleKey(quest.progress_window, referenceDate);
        if (seenCycleKeys.has(cycleKey)) {
          continue;
        }
        seenCycleKeys.add(cycleKey);

        const progress = await this.syncSwapProgressForQuest(
          userId,
          address,
          quest,
          referenceDate
        );

        if (progress?.completedAt && progress.awardedPoints > 0) {
          completedQuests.push({
            questId: quest.id,
            slug: quest.slug,
            awardedPoints: progress.awardedPoints,
          });
        }
      }
    }

    return completedQuests;
  }

  private async syncCampaignWhitelistForUser(
    userId: number,
    address: string,
    campaignKey?: string | null
  ) {
    const normalizedCampaignKey = normalizeCampaignKey(campaignKey);
    if (!campaignSupportsWhitelist(normalizedCampaignKey)) {
      return new Map<string, QuestCampaignWhitelistRecord>();
    }

    const now = getNow();
    const { data: questsData, error: questsError } = await supabase
      .from("quests")
      .select("*")
      .eq("campaign_key", normalizedCampaignKey)
      .eq("status", "published")
      .eq("is_active", true);

    if (questsError) {
      throw new Error(`Failed to load campaign quests: ${questsError.message}`);
    }

    const quests = ((questsData ?? []) as QuestRecord[]).filter((quest) =>
      isQuestLive(quest, now)
    );

    if (quests.length === 0) {
      return new Map<string, QuestCampaignWhitelistRecord>();
    }

    const { data: progressRows, error: progressError } = await supabase
      .from("quest_progress")
      .select("*")
      .eq("user_id", userId)
      .in(
        "quest_id",
        quests.map((quest) => quest.id)
      );

    if (progressError) {
      throw new Error(`Failed to load campaign progress: ${progressError.message}`);
    }

    const progressByKey = new Map(
      ((progressRows ?? []) as QuestProgressRecord[]).map((row) => [
        `${row.quest_id}:${row.cycle_key}`,
        row,
      ])
    );

    return this.ensureCampaignWhitelistState(
      userId,
      address,
      quests,
      progressByKey,
      now
    );
  }

  private async ensureCampaignWhitelistState(
    userId: number,
    address: string,
    quests: QuestRecord[],
    progressByKey: Map<string, QuestProgressRecord>,
    now: Date
  ) {
    const liveCampaignKeys = Array.from(
      new Set(
        quests
          .map((quest) => normalizeCampaignKey(quest.campaign_key))
          .filter((campaignKey) => campaignSupportsWhitelist(campaignKey))
      )
    );

    if (liveCampaignKeys.length === 0) {
      return new Map<string, QuestCampaignWhitelistRecord>();
    }

    const { data, error } = await supabase
      .from("quest_campaign_whitelist")
      .select("*")
      .eq("user_id", userId)
      .in("campaign_key", liveCampaignKeys);

    if (error) {
      throw new Error(`Failed to load campaign whitelist: ${error.message}`);
    }

    const whitelistByKey = new Map(
      ((data ?? []) as QuestCampaignWhitelistRecord[]).map((row) => [
        normalizeCampaignKey(row.campaign_key),
        row,
      ])
    );

    for (const campaignKey of liveCampaignKeys) {
      const campaignQuests = quests.filter(
        (quest) => normalizeCampaignKey(quest.campaign_key) === campaignKey
      );
      const completedQuests = campaignQuests.filter((quest) => {
        const cycleKey = getCycleKey(quest.progress_window, now);
        return Boolean(progressByKey.get(`${quest.id}:${cycleKey}`)?.completed_at);
      }).length;

      if (
        campaignQuests.length > 0 &&
        completedQuests >= campaignQuests.length &&
        !whitelistByKey.has(campaignKey)
      ) {
        const { data: whitelistRow, error: whitelistError } = await supabase
          .from("quest_campaign_whitelist")
          .upsert(
            {
              campaign_key: campaignKey,
              user_id: userId,
              wallet_address: address,
              status: "whitelisted",
              metadata: {
                source: "quest_campaign_completion",
                questCount: campaignQuests.length,
                completedAt: now.toISOString(),
              },
              updated_at: now.toISOString(),
            },
            {
              onConflict: "campaign_key,user_id",
            }
          )
          .select("*")
          .single();

        if (whitelistError) {
          throw new Error(`Failed to save campaign whitelist: ${whitelistError.message}`);
        }

        whitelistByKey.set(
          campaignKey,
          whitelistRow as QuestCampaignWhitelistRecord
        );
      }
    }

    return whitelistByKey;
  }

  private buildCampaignSummaries(
    quests: QuestRecord[],
    progressByKey: Map<string, QuestProgressRecord>,
    whitelistByKey: Map<string, QuestCampaignWhitelistRecord>,
    now: Date
  ) {
    const campaignKeys = Array.from(
      new Set(quests.map((quest) => normalizeCampaignKey(quest.campaign_key)))
    );

    return Object.fromEntries(
      campaignKeys.map((campaignKey) => {
        const campaignQuests = quests.filter(
          (quest) => normalizeCampaignKey(quest.campaign_key) === campaignKey
        );
        const completedQuests = campaignQuests.filter((quest) => {
          const cycleKey = getCycleKey(quest.progress_window, now);
          return Boolean(progressByKey.get(`${quest.id}:${cycleKey}`)?.completed_at);
        }).length;
        const whitelist = whitelistByKey.get(campaignKey) ?? null;
        const totalQuests = campaignQuests.length;
        const isComplete = totalQuests > 0 && completedQuests >= totalQuests;

        return [
          campaignKey,
          {
            key: campaignKey,
            label: getCampaignLabel(campaignKey),
            totalQuests,
            completedQuests,
            remainingQuests: Math.max(totalQuests - completedQuests, 0),
            isComplete,
            isWhitelisted: Boolean(whitelist),
            whitelistedAt: whitelist?.created_at || null,
          },
        ];
      })
    ) as Record<
      string,
      {
        key: string;
        label: string;
        totalQuests: number;
        completedQuests: number;
        remainingQuests: number;
        isComplete: boolean;
        isWhitelisted: boolean;
        whitelistedAt: string | null;
      }
    >;
  }

  private async assertLinkedSocialAccount(userId: number, platform: QuestPlatform) {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", userId)
      .eq("platform", platform)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to check linked ${platform} account: ${error.message}`);
    }

    if (!data) {
      if (platform === "x") {
        throw new Error("Connect X before starting this quest");
      }

      throw new Error(`Connect your ${platform.toUpperCase()} account before starting this quest`);
    }

    if (platform === "x" && !isConnectedXAccount(data as XSocialAccountRecord)) {
      throw new Error("Connect X before starting this quest");
    }
  }

  private async syncSwapProgressForQuest(
    userId: number,
    address: string,
    quest: QuestRecord,
    referenceDate: Date = getNow()
  ) {
    const now = referenceDate;
    const cycleKey = getCycleKey(quest.progress_window, now);
    const bounds = getWindowBounds(quest.progress_window, now);
    const rules = safeRules(quest.rules);
    const chainIds = getQuestChainIds(rules);
    const tokenFilter = getQuestTokenFilter(rules);
    const source = String(rules.source || "dustswap_swap");

    let query = supabase
      .from("swap_transactions")
      .select(
        "amount_usd, chain_id, src_token_address, dst_token_address, metadata"
      )
      .eq("user_id", userId);

    if (chainIds.length > 0) {
      query = query.in("chain_id", chainIds);
    }

    if (bounds) {
      query = query
        .gte("occurred_at", bounds.start.toISOString())
        .lt("occurred_at", bounds.end.toISOString());
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load swap transactions: ${error.message}`);
    }

    const filteredRows = ((data ?? []) as Array<{
      amount_usd: number | string | null;
      chain_id: number | null;
      src_token_address: string | null;
      dst_token_address: string | null;
      metadata: Record<string, unknown> | null;
    }>).filter((row) => swapTransactionMatchesToken(row, tokenFilter));

    const volumeValue = filteredRows.reduce(
      (sum, row) => sum + toNumber((row as { amount_usd: number }).amount_usd),
      0
    );
    const countValue = filteredRows.length;
    const progressValue =
      quest.action_type === "swap_count" ? countValue : volumeValue;

    const existing = await this.getProgress(userId, quest.id, cycleKey);
    const completedAlready = Boolean(existing?.completed_at);
    const nowIso = now.toISOString();

    const updated = await this.upsertProgress({
      userId,
      quest,
      cycleKey,
      updates: {
        status:
          progressValue >= quest.target_value
            ? "completed"
            : progressValue > 0
              ? "in_progress"
              : "not_started",
        progress: progressValue,
        target_value: quest.target_value,
        completed_at:
          progressValue >= quest.target_value
            ? existing?.completed_at || nowIso
            : null,
      },
    });

    if (!completedAlready && progressValue >= quest.target_value) {
      const completion = await this.completeQuest(
        userId,
        address,
        quest,
        cycleKey,
        {
          eventType: "swap",
          countValue,
          volumeValue,
          progressValue,
          source,
          chainIds,
          tokenFilter,
        }
      );

      return {
        progress: completion.progress.progress,
        completedAt: completion.progress.completed_at,
        awardedPoints: completion.awardedPoints,
      };
    }

    return {
      progress: updated.progress,
      completedAt: updated.completed_at,
      awardedPoints: 0,
    };
  }

  private async completeQuest(
    userId: number,
    address: string,
    quest: QuestRecord,
    cycleKey: string,
    metadata: Record<string, unknown>
  ) {
    const progress = await this.getProgress(userId, quest.id, cycleKey);

    if (!progress) {
      throw new Error("Quest progress was not found");
    }

    if (progress.rewarded_at) {
      const nowIso = new Date().toISOString();
      const nextMetadata = {
        ...(progress.metadata || {}),
        ...metadata,
        completedAt: progress.completed_at || nowIso,
      };
      const updated = progress.completed_at
        ? progress
        : await this.upsertProgress({
            userId,
            quest,
            cycleKey,
            updates: {
              status: "completed",
              progress: Math.max(progress.progress, quest.target_value),
              target_value: quest.target_value,
              completed_at: nowIso,
              verified_by_api:
                metadata.verified_by_api === true
                  ? true
                  : progress.verified_by_api ?? false,
              verified_at:
                typeof metadata.verified_at === "string"
                  ? metadata.verified_at
                  : progress.verified_at ?? null,
              metadata: nextMetadata,
            },
          });

      await this.syncCampaignWhitelistForUser(
        userId,
        address,
        normalizeCampaignKey(quest.campaign_key)
      );
      this.invalidateQuestBoardCache(address);
      return {
        progress: updated,
        awardedPoints: 0,
      };
    }

    const nowIso = new Date().toISOString();
    const nextMetadata = {
      ...(progress.metadata || {}),
      ...metadata,
      completedAt: nowIso,
    };

    const updated = await this.upsertProgress({
      userId,
      quest,
      cycleKey,
      updates: {
        status: "completed",
        progress: Math.max(progress.progress, quest.target_value),
        target_value: quest.target_value,
        completed_at: progress.completed_at || nowIso,
        rewarded_at: nowIso,
        verified_by_api:
          metadata.verified_by_api === true ? true : progress.verified_by_api ?? false,
        verified_at:
          typeof metadata.verified_at === "string"
            ? metadata.verified_at
            : progress.verified_at ?? null,
        metadata: nextMetadata,
      },
    });

    const awardedPoints = await pointsEngine.awardCustomPoints(
      address,
      quest.reward_points,
      "quest_completion",
      {
        questId: quest.id,
        questSlug: quest.slug,
        cycleKey,
        campaignKey: normalizeCampaignKey(quest.campaign_key),
        category: quest.category,
        platform: quest.platform,
      }
    );

    await this.syncCampaignWhitelistForUser(
      userId,
      address,
      normalizeCampaignKey(quest.campaign_key)
    );
    this.invalidateQuestBoardCache(address);

    return {
      progress: updated,
      awardedPoints,
    };
  }

  private async getQuestById(id: string) {
    const { data, error } = await supabase
      .from("quests")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      throw new Error("Quest not found");
    }

    const quest = data as QuestRecord;
    if (!isQuestLive(quest, getNow())) {
      throw new Error("Quest is not active right now");
    }

    return quest;
  }

  private async getProgress(userId: number, questId: string, cycleKey: string) {
    const { data, error } = await supabase
      .from("quest_progress")
      .select("*")
      .eq("user_id", userId)
      .eq("quest_id", questId)
      .eq("cycle_key", cycleKey)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load quest progress: ${error.message}`);
    }

    return (data as QuestProgressRecord | null) ?? null;
  }

  private async upsertProgress(args: {
    userId: number;
    quest: QuestRecord;
    cycleKey: string;
    existing?: QuestProgressRecord | null;
    updates: Record<string, unknown>;
  }) {
    const existing =
      args.existing !== undefined
        ? args.existing
        : await this.getProgress(args.userId, args.quest.id, args.cycleKey);

    const payload = {
      id: existing?.id,
      user_id: args.userId,
      quest_id: args.quest.id,
      cycle_key: args.cycleKey,
      status: existing?.status || "not_started",
      progress: existing?.progress ?? 0,
      target_value: existing?.target_value ?? args.quest.target_value,
      verification_attempts: existing?.verification_attempts ?? 0,
      fake_failures_served: existing?.fake_failures_served ?? 0,
      opened_at: existing?.opened_at ?? null,
      next_verification_at: existing?.next_verification_at ?? null,
      completed_at: existing?.completed_at ?? null,
      rewarded_at: existing?.rewarded_at ?? null,
      verified_by_api: existing?.verified_by_api ?? false,
      verified_at: existing?.verified_at ?? null,
      metadata: existing?.metadata ?? {},
      updated_at: new Date().toISOString(),
      ...args.updates,
    };

    const { data, error } = await supabase
      .from("quest_progress")
      .upsert(payload, {
        onConflict: "user_id,quest_id,cycle_key",
      })
      .select("*")
      .single();

    if (error) {
      throw new Error(`Failed to save quest progress: ${error.message}`);
    }

    return data as QuestProgressRecord;
  }

  private async logVerificationAttempt(
    userId: number,
    questId: string,
    cycleKey: string,
    status: string,
    requestPayload: Record<string, unknown>,
    responsePayload: Record<string, unknown>
  ) {
    await supabase.from("quest_verification_logs").insert({
      user_id: userId,
      quest_id: questId,
      cycle_key: cycleKey,
      status,
      request_payload: requestPayload,
      response_payload: responsePayload,
    });
  }
}

export const questEngine = new QuestEngine();
