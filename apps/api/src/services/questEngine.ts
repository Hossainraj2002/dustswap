import { randomBytes, createHash, createHmac } from "crypto";
import { createPublicClient, http, isAddress } from "viem";
import { base } from "viem/chains";
import { pointsEngine } from "./pointsEngine";
import { supabase } from "./supabase";

type QuestCategory = "social" | "onchain";
type QuestPlatform = "x" | "base" | "dustswap";
type QuestActionType =
  | "swap_volume"
  | "swap_count"
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
  fakeFailureCount?: number;
  requiredMention?: string;
  requiredMentionsAny?: string[];
  requiredHashtags?: string[];
  requiredLinks?: string[];
  composeText?: string;
  externalUrl?: string;
  source?: string;
  [key: string]: unknown;
};

type QuestRecord = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
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

export type AdminQuestInput = {
  id?: string;
  slug: string;
  title: string;
  description?: string | null;
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
  amountUsd: number;
  inputToken?: string | null;
  outputToken?: string | null;
  metadata?: Record<string, unknown>;
};

type OpenOceanWalletTransaction = {
  txHash?: string;
  tradeTime?: string;
  inAmount?: string;
  outAmount?: string;
  inToken?: string;
  outToken?: string;
};

type OpenOceanTransactionDetail = {
  tx_hash?: string;
  sender?: string;
  receiver?: string;
  referrer?: string;
  usd_valuation?: number | string;
  create_at?: string;
  update_at?: string;
  in_token_symbol?: string;
  out_token_symbol?: string;
  in_amount_value?: string;
  out_amount_value?: string;
};

const X_SCOPES = ["tweet.read", "users.read", "offline.access"];
const BASE_RPC_URL =
  process.env.BASE_RPC_URL ||
  process.env.NEXT_PUBLIC_BASE_RPC_URL ||
  "https://mainnet.base.org";
const OPENOCEAN_API_BASE =
  process.env.OPENOCEAN_API_BASE || "https://open-api.openocean.finance/v3";
const OPENOCEAN_REFERRER_ADDRESS =
  process.env.OPENOCEAN_REFERRER_ADDRESS ||
  process.env.NEXT_PUBLIC_OPENOCEAN_REFERRER_ADDRESS ||
  "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573";

const baseClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
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

function getStateSecret() {
  const secret = process.env.X_STATE_SECRET || process.env.QUEST_STATE_SECRET;
  if (!secret) {
    throw new Error("X_STATE_SECRET is required for X account linking");
  }
  return secret;
}

function encodeState(payload: Record<string, unknown>) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json).toString("base64url");
  const signature = createHmac("sha256", getStateSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function decodeState(state: string) {
  const [body, signature] = state.split(".");
  if (!body || !signature) {
    throw new Error("Invalid X auth state");
  }

  const expected = createHmac("sha256", getStateSecret())
    .update(body)
    .digest("base64url");

  if (signature !== expected) {
    throw new Error("Invalid X auth signature");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  return payload as {
    address: string;
    returnTo: string;
    codeVerifier: string;
    createdAt: string;
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

function getXBearerToken() {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    throw new Error("X_BEARER_TOKEN is required for X post verification");
  }
  return token;
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

function extractPostId(input: string) {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(/status\/(\d+)/i);
  return match?.[1] ?? null;
}

function includesToken(text: string, expected: string) {
  return text.toLowerCase().includes(expected.toLowerCase());
}

function listMentionCandidates(tweet: any): string[] {
  const mentions = tweet?.entities?.mentions;
  if (!Array.isArray(mentions)) {
    return [];
  }

  return mentions
    .map((item) => item?.username)
    .filter(Boolean)
    .map((value) => normalizeMentionValue(String(value)));
}

function listHashtagCandidates(tweet: any): string[] {
  const hashtags = tweet?.entities?.hashtags;
  if (!Array.isArray(hashtags)) {
    return [];
  }

  return hashtags
    .map((item) => item?.tag)
    .filter(Boolean)
    .map((value) => normalizeHashtagValue(String(value)));
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

function getSwapAmountUsdFallback(
  amountUsd: number,
  metadata?: Record<string, unknown>
) {
  if (amountUsd > 0) {
    return amountUsd;
  }

  const candidates = [
    metadata?.fromAmountUSD,
    metadata?.toAmountUSD,
    metadata?.fromAmountUsd,
    metadata?.toAmountUsd,
  ];

  for (const candidate of candidates) {
    const parsed = toNumber(candidate, -1);
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

async function fetchOpenOceanData<T>(path: string) {
  const response = await fetch(`${OPENOCEAN_API_BASE}${path}`, {
    headers: {
      Accept: "application/json",
    },
  });

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

export class QuestEngine {
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

    return data as QuestRecord;
  }

  async deleteQuest(id: string) {
    const { error } = await supabase.from("quests").delete().eq("id", id);

    if (error) {
      throw new Error(`Failed to delete quest: ${error.message}`);
    }

    return { success: true };
  }

  async getQuestBoard(address?: string) {
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

    if (address) {
      const user = await pointsEngine.getOrCreate(address);
      const { data: socialData } = await supabase
        .from("social_accounts")
        .select("*")
        .eq("user_id", user.id);

      linkedAccounts = Object.fromEntries(
        ((socialData ?? []) as SocialAccountRecord[]).map((account) => [
          account.platform,
          {
            username: account.username,
            platformUserId: account.platform_user_id,
            displayName: account.display_name,
            profileImageUrl: account.profile_image_url,
          },
        ])
      );

      const { data: progressRows } = await supabase
        .from("quest_progress")
        .select("*")
        .eq("user_id", user.id);

      progressByKey = new Map(
        ((progressRows ?? []) as QuestProgressRecord[]).map((row) => [
          `${row.quest_id}:${row.cycle_key}`,
          row,
        ])
      );

      for (const quest of quests) {
        if (
          quest.category === "onchain" &&
          (quest.action_type === "swap_volume" || quest.action_type === "swap_count")
        ) {
          await this.syncSwapProgressForQuest(
            user.id,
            normalizeAddress(address),
            quest
          );
        }
      }

      const { data: refreshedProgressRows } = await supabase
        .from("quest_progress")
        .select("*")
        .eq("user_id", user.id);

      progressByKey = new Map(
        ((refreshedProgressRows ?? []) as QuestProgressRecord[]).map((row) => [
          `${row.quest_id}:${row.cycle_key}`,
          row,
        ])
      );
    }

    const questItems = quests.map((quest) => {
      const cycleKey = getCycleKey(quest.progress_window, now);
      const progress = progressByKey.get(`${quest.id}:${cycleKey}`) ?? null;

      return {
        id: quest.id,
        slug: quest.slug,
        title: quest.title,
        description: quest.description,
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
        progress: progress
          ? {
              status: progress.status,
              value: progress.progress,
              targetValue: progress.target_value,
              verificationAttempts: progress.verification_attempts,
              fakeFailuresServed: progress.fake_failures_served,
              nextVerificationAt: progress.next_verification_at,
              openedAt: progress.opened_at,
              completedAt: progress.completed_at,
            }
          : null,
      };
    });

    return {
      linkedAccounts,
      quests: questItems,
      serverTime: now.toISOString(),
    };
  }

  async saveManualXUsername(address: string, username: string) {
    if (!isAddress(address)) {
      throw new Error("A valid wallet address is required");
    }

    const normalizedAddress = normalizeAddress(address);
    const normalizedUsername = normalizeXUsernameInput(username);
    const user = await pointsEngine.getOrCreate(normalizedAddress);

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

    return {
      success: true,
      username: normalizedUsername.display,
    };
  }

  async createXAuthUrl(address: string, returnTo: string) {
    if (!isAddress(address)) {
      throw new Error("A valid wallet address is required");
    }

    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const redirectUri = getXRedirectUri();

    const state = encodeState({
      address: normalizeAddress(address),
      returnTo,
      codeVerifier,
      createdAt: new Date().toISOString(),
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
    const payload = decodeState(state);
    const createdAt = new Date(payload.createdAt);
    if (Date.now() - createdAt.getTime() > 10 * 60 * 1000) {
      throw new Error("X auth session expired, please try again");
    }

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

    const meResponse = await fetch("https://api.x.com/2/users/me", {
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

    const user = await pointsEngine.getOrCreate(payload.address);
    const tokenExpiresAt = tokenJson.expires_in
      ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
      : null;

    const normalizedUsername = normalizeXUsernameInput(meJson.data.username);

    const { error } = await supabase
      .from("social_accounts")
      .upsert(
        {
          user_id: user.id,
          platform: "x",
          platform_user_id: normalizedUsername.key,
          username: normalizedUsername.display,
          display_name: meJson.data.name || null,
          profile_image_url: meJson.data.profile_image_url || null,
          access_token: tokenJson.access_token,
          refresh_token: tokenJson.refresh_token || null,
          scope: tokenJson.scope || X_SCOPES.join(" "),
          token_expires_at: tokenExpiresAt,
          metadata: {
            linkedAt: new Date().toISOString(),
            authorId: meJson.data.id,
          },
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "user_id,platform",
        }
      );

    if (error) {
      throw new Error(`Failed to save X account: ${error.message}`);
    }

    return {
      address: payload.address,
      returnTo: payload.returnTo,
      username: normalizedUsername.display,
    };
  }

  async startDelayQuest(address: string, questId: string) {
    const quest = await this.getQuestById(questId);
    const rules = safeRules(quest.rules);
    const user = await pointsEngine.getOrCreate(address);

    if (quest.platform === "x") {
      await this.assertLinkedSocialAccount(user.id, "x");
    }

    const delaySeconds = toNumber(rules.delaySeconds, 20);
    const now = getNow();
    const cycleKey = getCycleKey(quest.progress_window, now);

    const progress = await this.upsertProgress({
      userId: user.id,
      quest,
      cycleKey,
      updates: {
        status: "in_progress",
        opened_at: now.toISOString(),
        next_verification_at: new Date(
          now.getTime() + delaySeconds * 1000
        ).toISOString(),
      },
    });

    return {
      success: true,
      questId,
      nextVerificationAt: progress.next_verification_at,
    };
  }

  async verifyDelayQuest(address: string, questId: string) {
    const quest = await this.getQuestById(questId);
    const rules = safeRules(quest.rules);
    const user = await pointsEngine.getOrCreate(address);

    if (quest.platform === "x") {
      await this.assertLinkedSocialAccount(user.id, "x");
    }

    const cycleKey = getCycleKey(quest.progress_window, getNow());
    const progress = await this.getProgress(user.id, quest.id, cycleKey);

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

    const fakeFailureCount = toNumber(rules.fakeFailureCount, 0);

    if (progress.fake_failures_served < fakeFailureCount) {
      const updated = await this.upsertProgress({
        userId: user.id,
        quest,
        cycleKey,
        updates: {
          status: "retry_required",
          verification_attempts: progress.verification_attempts + 1,
          fake_failures_served: progress.fake_failures_served + 1,
        },
      });

      await this.logVerificationAttempt(
        user.id,
        quest.id,
        cycleKey,
        "retry_required",
        { verificationType: quest.verification_type },
        { fakeFailuresServed: updated.fake_failures_served }
      );

      return {
        success: false,
        status: "retry_required",
        message: "We could not confirm it yet. Revisit the task and try again.",
      };
    }

    const completed = await this.completeQuest(
      user.id,
      normalizeAddress(address),
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
    const cycleKey = getCycleKey(quest.progress_window, getNow());

    const { data: accountData, error: accountError } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", user.id)
      .eq("platform", "x")
      .single();

    if (accountError || !accountData) {
      throw new Error("Add your X username before verifying this quest");
    }

    const postId = extractPostId(postUrl);
    if (!postId) {
      throw new Error("Enter a valid X post link");
    }

    const lookupUrl = new URL(`https://api.x.com/2/tweets/${postId}`);
    lookupUrl.searchParams.set(
      "tweet.fields",
      "author_id,created_at,entities,text,referenced_tweets"
    );
    lookupUrl.searchParams.set("expansions", "author_id");
    lookupUrl.searchParams.set("user.fields", "username");

    const tweetResponse = await fetch(lookupUrl, {
      headers: {
        Authorization: `Bearer ${getXBearerToken()}`,
      },
    });

    const rawResponse = await tweetResponse.text();
    if (!tweetResponse.ok) {
      await this.logVerificationAttempt(
        user.id,
        quest.id,
        cycleKey,
        "failed",
        { postUrl },
        { error: rawResponse }
      );
      throw new Error("We could not read that X post. Check the link and try again.");
    }

    const tweetJson = JSON.parse(rawResponse) as {
      data?: {
        id: string;
        author_id?: string;
        text?: string;
        entities?: Record<string, unknown>;
      };
      includes?: {
        users?: Array<{
          id?: string;
          username?: string;
        }>;
      };
    };

    const tweet = tweetJson.data;
    if (!tweet?.id || !tweet.author_id || !tweet.text) {
      throw new Error("That X post is missing required data for verification");
    }

    const author = (tweetJson.includes?.users || []).find(
      (userRow) => userRow.id === tweet.author_id
    );
    const authorUsername = author?.username?.toLowerCase();
    const savedUsername = String(
      (accountData as SocialAccountRecord).platform_user_id || ""
    ).toLowerCase();

    if (!authorUsername) {
      throw new Error("That X post is missing author username data");
    }

    if (authorUsername !== savedUsername) {
      throw new Error("That post was not authored by your saved X username");
    }

    const text = tweet.text;
    const requiredMention = String(rules.requiredMention || "").trim();
    const requiredMentionsAny = Array.isArray(rules.requiredMentionsAny)
      ? rules.requiredMentionsAny.map((value) => String(value).trim()).filter(Boolean)
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

    if (requiredMention && !includesToken(text, requiredMention)) {
      throw new Error(`Your post must include ${requiredMention}`);
    }

    if (requiredMentionsAny.length > 0) {
      const matchedMention = requiredMentionsAny.some((mention) => {
        const normalized = normalizeMentionValue(mention);
        return (
          mentionCandidates.includes(normalized) ||
          includesToken(text, mention)
        );
      });

      if (!matchedMention) {
        throw new Error(
          `Your post must mention ${requiredMentionsAny.join(" or ")}`
        );
      }
    }

    for (const hashtag of requiredHashtags) {
      const normalized = normalizeHashtagValue(hashtag);
      const matched =
        hashtagCandidates.includes(normalized) ||
        includesToken(text, hashtag);
      if (!matched) {
        throw new Error(`Your post must include ${hashtag}`);
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
        authorId: tweet.author_id,
        authorUsername,
      }
    );

    await this.logVerificationAttempt(
      user.id,
      quest.id,
      cycleKey,
      "completed",
      { postUrl },
      { postId, authorUsername, rewardedPoints: completed.awardedPoints }
    );

    return {
      success: true,
      status: "completed",
      postId,
      awardedPoints: completed.awardedPoints,
    };
  }

  async syncRecentSwapActivity(address: string) {
    if (!isAddress(address)) {
      throw new Error("A valid wallet address is required");
    }

    const normalizedAddress = normalizeAddress(address);
    const user = await pointsEngine.getOrCreate(normalizedAddress);
    const knownHashes = await this.getKnownSwapAmounts(user.id);

    const params = new URLSearchParams({
      account: normalizedAddress,
      pageSize: "15",
    });

    const history = await fetchOpenOceanData<OpenOceanWalletTransaction[]>(
      `/base/getTxs?${params.toString()}`
    );

    const importedHashes: string[] = [];
    const expectedReferrer = OPENOCEAN_REFERRER_ADDRESS.toLowerCase();

    for (const item of history ?? []) {
      const txHash = item.txHash;
      if (!txHash) {
        continue;
      }

      const knownAmount = knownHashes.get(txHash) ?? -1;
      if (knownAmount > 0) {
        continue;
      }

      try {
        const detail = await fetchOpenOceanData<OpenOceanTransactionDetail>(
          `/base/getTransaction?hash=${encodeURIComponent(txHash)}`
        );

        const resolvedHash = detail.tx_hash || txHash;
        const sender = String(detail.sender || detail.receiver || "").toLowerCase();
        if (sender && sender !== normalizedAddress) {
          continue;
        }

        const referrer = String(detail.referrer || "").toLowerCase();
        if (!referrer || referrer !== expectedReferrer) {
          continue;
        }

        const amountUsd = toNumber(detail.usd_valuation, 0);
        await this.upsertSwapActivityEvent({
          userId: user.id,
          chainId: base.id,
          txHash: resolvedHash,
          amountUsd,
          inputToken: detail.in_token_symbol || item.inToken || null,
          outputToken: detail.out_token_symbol || item.outToken || null,
          occurredAt:
            detail.update_at ||
            detail.create_at ||
            item.tradeTime ||
            new Date().toISOString(),
          metadata: {
            source: "openocean_history_sync",
            referrer: detail.referrer || null,
            inAmountValue: detail.in_amount_value || item.inAmount || null,
            outAmountValue: detail.out_amount_value || item.outAmount || null,
            tradeTime: detail.update_at || detail.create_at || item.tradeTime || null,
          },
        });
        await pointsEngine.recordSwap(normalizedAddress, {
          txHash: resolvedHash,
          chainId: base.id,
          inputToken: detail.in_token_symbol || item.inToken || null,
          outputToken: detail.out_token_symbol || item.outToken || null,
          volumeUsd: amountUsd,
          awardPoints: false,
        });

        importedHashes.push(resolvedHash);
        knownHashes.set(resolvedHash, amountUsd);
      } catch {
        // Ignore individual lookup failures so one bad tx does not block all sync.
      }
    }

    const completedQuests = await this.syncPublishedSwapQuests(
      user.id,
      normalizedAddress
    );

    return {
      success: true,
      importedHashes,
      completedQuests,
    };
  }

  async recordSwapActivity(input: SwapActivityInput) {
    if (!isAddress(input.address)) {
      throw new Error("A valid wallet address is required");
    }

    if (!input.txHash) {
      throw new Error("Transaction hash is required");
    }

    const receipt = await baseClient.getTransactionReceipt({
      hash: input.txHash as `0x${string}`,
    });

    if (receipt.status !== "success") {
      throw new Error("Swap transaction is not confirmed");
    }

    const normalizedAmountUsd = getSwapAmountUsdFallback(
      input.amountUsd,
      input.metadata
    );
    const normalizedAddress = normalizeAddress(input.address);
    const user = await pointsEngine.getOrCreate(input.address);
    await this.upsertSwapActivityEvent({
      userId: user.id,
      chainId: input.chainId,
      txHash: input.txHash,
      amountUsd: normalizedAmountUsd,
      inputToken: input.inputToken,
      outputToken: input.outputToken,
      occurredAt: new Date().toISOString(),
      metadata: input.metadata,
    });
    await pointsEngine.recordSwap(normalizedAddress, {
      txHash: input.txHash,
      chainId: input.chainId,
      inputToken: input.inputToken,
      outputToken: input.outputToken,
      volumeUsd: normalizedAmountUsd,
      awardPoints: false,
    });

    const completedQuests = await this.syncPublishedSwapQuests(
      user.id,
      normalizedAddress
    );

    return {
      success: true,
      completedQuests,
    };
  }

  private async getKnownSwapAmounts(userId: number) {
    const { data, error } = await supabase
      .from("activity_events")
      .select("tx_hash, amount_usd")
      .eq("user_id", userId)
      .eq("event_type", "swap")
      .eq("source", "dustswap_swap");

    if (error) {
      throw new Error(`Failed to load existing swap activity: ${error.message}`);
    }

    return new Map(
      (data ?? []).map((row) => [
        String((row as { tx_hash: string }).tx_hash),
        toNumber((row as { amount_usd: number }).amount_usd),
      ])
    );
  }

  private async upsertSwapActivityEvent(args: {
    userId: number;
    chainId: number;
    txHash: string;
    amountUsd: number;
    inputToken?: string | null;
    outputToken?: string | null;
    occurredAt?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const { error } = await supabase.from("activity_events").upsert(
      {
        user_id: args.userId,
        event_type: "swap",
        source: "dustswap_swap",
        chain_id: args.chainId,
        tx_hash: args.txHash,
        amount_usd: args.amountUsd,
        occurred_at: args.occurredAt || new Date().toISOString(),
        metadata: {
          inputToken: args.inputToken || null,
          outputToken: args.outputToken || null,
          ...(args.metadata || {}),
        },
      },
      {
        onConflict: "tx_hash,event_type,source",
      }
    );

    if (error) {
      throw new Error(`Failed to record swap activity: ${error.message}`);
    }
  }

  private async syncPublishedSwapQuests(userId: number, address: string) {
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

    for (const quest of (questsData ?? []) as QuestRecord[]) {
      const progress = await this.syncSwapProgressForQuest(userId, address, quest);

      if (progress?.completedAt && progress.awardedPoints > 0) {
        completedQuests.push({
          questId: quest.id,
          slug: quest.slug,
          awardedPoints: progress.awardedPoints,
        });
      }
    }

    return completedQuests;
  }

  private async assertLinkedSocialAccount(userId: number, platform: QuestPlatform) {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("platform", platform)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to check linked ${platform} account: ${error.message}`);
    }

    if (!data) {
      if (platform === "x") {
        throw new Error("Add your X username before starting this quest");
      }

      throw new Error(`Connect your ${platform.toUpperCase()} account before starting this quest`);
    }
  }

  private async syncSwapProgressForQuest(
    userId: number,
    address: string,
    quest: QuestRecord
  ) {
    const now = getNow();
    const cycleKey = getCycleKey(quest.progress_window, now);
    const bounds = getWindowBounds(quest.progress_window, now);

    let query = supabase
      .from("activity_events")
      .select("amount_usd")
      .eq("user_id", userId)
      .eq("event_type", "swap")
      .eq("source", String(safeRules(quest.rules).source || "dustswap_swap"));

    if (bounds) {
      query = query
        .gte("occurred_at", bounds.start.toISOString())
        .lt("occurred_at", bounds.end.toISOString());
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load swap activity: ${error.message}`);
    }

    const volumeValue = (data ?? []).reduce(
      (sum, row) => sum + toNumber((row as { amount_usd: number }).amount_usd),
      0
    );
    const countValue = (data ?? []).length;
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
      return {
        progress,
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
        category: quest.category,
        platform: quest.platform,
      }
    );

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
    updates: Record<string, unknown>;
  }) {
    const existing = await this.getProgress(
      args.userId,
      args.quest.id,
      args.cycleKey
    );

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
