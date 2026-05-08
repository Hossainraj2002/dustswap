import { createHash } from "crypto";
import { runtimeCache } from "../utils/runtimeCache";
import { supabase } from "./supabase";

export type XSocialAccountRecord = {
  id: number;
  user_id: number;
  platform: string;
  platform_user_id: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ConnectedXAccount = {
  id: number;
  userId: number;
  xUserId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  connectedAt: string | null;
};

export type GetXUserProfile = {
  id: string;
  userName: string;
  name?: string | null;
  profilePicture?: string | null;
  protected?: boolean | null;
};

export type GetXTweet = {
  id: string;
  text?: string | null;
  author?: {
    id?: string | null;
    userName?: string | null;
    name?: string | null;
    profilePicture?: string | null;
  } | null;
  author_id?: string | null;
  entities?: Record<string, unknown> | null;
  isReply?: boolean | null;
  inReplyToId?: string | null;
  conversationId?: string | null;
  inReplyToUserId?: string | null;
  url?: string | null;
  twitterUrl?: string | null;
};

export type GetXFollower = {
  id?: string | null;
  userName?: string | null;
  username?: string | null;
  name?: string | null;
  profilePicture?: string | null;
};

const GETX_API_BASE = (process.env.GETX_API_BASE || "https://api.getxapi.com").replace(/\/+$/, "");
const GETX_TIMEOUT_MS = Math.min(
  20_000,
  Math.max(1_000, Number(process.env.GETX_TIMEOUT_MS || "8000"))
);
const GETX_USER_CACHE_TTL_MS = Math.min(
  30 * 60 * 1000,
  Math.max(30_000, Number(process.env.GETX_USER_CACHE_TTL_MS || "300000"))
);
const GETX_TWEET_CACHE_TTL_MS = Math.min(
  5 * 60 * 1000,
  Math.max(10_000, Number(process.env.GETX_TWEET_CACHE_TTL_MS || "60000"))
);
const GETX_FOLLOW_CACHE_TTL_MS = Math.min(
  5 * 60 * 1000,
  Math.max(10_000, Number(process.env.GETX_FOLLOW_CACHE_TTL_MS || "30000"))
);
const NUMERIC_X_ID_PATTERN = /^\d{1,32}$/;

function getGetXApiKey() {
  const apiKey = process.env.GETX_API_KEY || process.env.GETXAPI_API_KEY;
  if (!apiKey) {
    throw new Error("GETX_API_KEY is required for X social verification");
  }

  return apiKey;
}

function normalizeXUsername(value: string) {
  const normalized = value.trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(normalized)) {
    throw new Error("Invalid X username");
  }

  return normalized;
}

function safeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hashCachePart(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function getResponseError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as { error?: unknown; msg?: unknown; message?: unknown };
    return String(record.error || record.msg || record.message || fallback);
  }

  return fallback;
}

async function parseJsonSafely(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

export function getConnectedXUserId(account: Pick<XSocialAccountRecord, "platform_user_id" | "metadata">) {
  const metadata = safeMetadata(account.metadata);
  const candidates = [
    metadata.xUserId,
    metadata.x_user_id,
    metadata.authorId,
    metadata.author_id,
    account.platform_user_id,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (NUMERIC_X_ID_PATTERN.test(value)) {
      return value;
    }
  }

  return null;
}

export function isConnectedXAccount(account: Pick<XSocialAccountRecord, "platform_user_id" | "metadata">) {
  const metadata = safeMetadata(account.metadata);
  if (metadata.disconnectedAt || metadata.disconnected_at) {
    return false;
  }

  if (metadata.linkedManually === true && !getConnectedXUserId(account)) {
    return false;
  }

  return Boolean(getConnectedXUserId(account));
}

export function toXAccountSummary(account: XSocialAccountRecord | null) {
  if (!account) {
    return null;
  }

  const metadata = safeMetadata(account.metadata);
  const xUserId = getConnectedXUserId(account);
  const connected = Boolean(xUserId && isConnectedXAccount(account));

  return {
    username: account.username,
    platformUserId: connected ? xUserId : account.platform_user_id,
    xUserId,
    displayName: account.display_name,
    profileImageUrl: account.profile_image_url,
    connected,
    connectedAt:
      (typeof metadata.connectedAt === "string" && metadata.connectedAt) ||
      (typeof metadata.linkedAt === "string" && metadata.linkedAt) ||
      null,
    legacyManual: metadata.linkedManually === true && !connected,
  };
}

export class XVerificationService {
  async requireConnectedAccount(userId: number) {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", userId)
      .eq("platform", "x")
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load connected X account: ${error.message}`);
    }

    const account = (data as XSocialAccountRecord | null) ?? null;
    if (!account || !isConnectedXAccount(account)) {
      throw new Error("Connect X before verifying this task");
    }

    const xUserId = getConnectedXUserId(account);
    if (!xUserId) {
      throw new Error("Reconnect X before verifying this task");
    }
    const metadata = safeMetadata(account.metadata);

    return {
      id: Number(account.id),
      userId: Number(account.user_id),
      xUserId,
      username: account.username,
      displayName: account.display_name,
      avatarUrl: account.profile_image_url,
      connectedAt:
        (typeof metadata.connectedAt === "string" && metadata.connectedAt) ||
        (typeof metadata.linkedAt === "string" && metadata.linkedAt) ||
        null,
    } satisfies ConnectedXAccount;
  }

  async getAccountSummary(userId: number) {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", userId)
      .eq("platform", "x")
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load X account: ${error.message}`);
    }

    return toXAccountSummary((data as XSocialAccountRecord | null) ?? null);
  }

  async requestGetX<T>(
    path: string,
    options?: {
      method?: "GET" | "POST";
      query?: Record<string, string>;
      body?: Record<string, unknown>;
    }
  ) {
    const url = new URL(`${GETX_API_BASE}${path}`);
    for (const [key, value] of Object.entries(options?.query || {})) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GETX_TIMEOUT_MS);

    const response = await fetch(url, {
      method: options?.method || "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${getGetXApiKey()}`,
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    }).finally(() => clearTimeout(timeoutId));

    const payload = await parseJsonSafely(response);
    if (!response.ok) {
      throw new Error(
        getResponseError(payload, `GetX API request failed with ${response.status}`)
      );
    }

    return payload as T;
  }

  async getUserById(userId: string) {
    const normalizedId = String(userId || "").trim();
    if (!NUMERIC_X_ID_PATTERN.test(normalizedId)) {
      throw new Error("A valid X user id is required");
    }

    return runtimeCache.getOrSet(
      `getx:user:id:${normalizedId}`,
      GETX_USER_CACHE_TTL_MS,
      async () => {
        const payload = await this.requestGetX<{ data?: GetXUserProfile }>(
          "/twitter/user/info_by_id",
          {
            query: { userId: normalizedId },
          }
        );

        if (!payload.data?.id || !payload.data.userName) {
          throw new Error("GetX returned no X user profile");
        }

        return payload.data;
      }
    );
  }

  async getUserByUsername(username: string) {
    const normalizedUsername = normalizeXUsername(username);
    return runtimeCache.getOrSet(
      `getx:user:username:${normalizedUsername.toLowerCase()}`,
      GETX_USER_CACHE_TTL_MS,
      async () => {
        const payload = await this.requestGetX<{ data?: GetXUserProfile }>(
          "/twitter/user/info",
          {
            query: { userName: normalizedUsername },
          }
        );

        if (!payload.data?.id || !payload.data.userName) {
          throw new Error("GetX returned no X user profile");
        }

        return payload.data;
      }
    );
  }

  async getFollowersPage(username: string, cursor?: string | null) {
    const normalizedUsername = normalizeXUsername(username);
    const payload = await this.requestGetX<{
      data?: {
        followers?: GetXFollower[];
        has_more?: boolean;
        next_cursor?: string | null;
        user_count?: number;
      };
      followers?: GetXFollower[];
      has_more?: boolean;
      next_cursor?: string | null;
      user_count?: number;
    }>("/twitter/user/followers", {
      query: {
        userName: normalizedUsername,
        ...(cursor ? { cursor } : {}),
      },
    });

    const body = payload.data || payload;
    return {
      followers: Array.isArray(body.followers) ? body.followers : [],
      hasMore: body.has_more === true,
      nextCursor: typeof body.next_cursor === "string" ? body.next_cursor : null,
      userCount: typeof body.user_count === "number" ? body.user_count : null,
    };
  }

  async resolveUser(input: { userId?: string | null; username?: string | null }) {
    if (input.username) {
      return {
        id: input.userId || "",
        userName: normalizeXUsername(input.username),
      } satisfies GetXUserProfile;
    }

    if (input.userId) {
      return this.getUserById(input.userId);
    }

    throw new Error("X target user id is required");
  }

  async checkFollowById(
    sourceUserId: string,
    target: { userId?: string | null; username?: string | null }
  ) {
    return this.checkFollowRelationship({ userId: sourceUserId }, target);
  }

  async checkFollowRelationship(
    source: { userId?: string | null; username?: string | null },
    target: { userId?: string | null; username?: string | null }
  ) {
    const sourceHash = hashCachePart(`${source.userId || ""}:${source.username || ""}`);
    const targetHash = hashCachePart(`${target.userId || ""}:${target.username || ""}`);
    const cacheKey = `getx:follow:${sourceHash}:${targetHash}`;

    return runtimeCache.getOrSet(cacheKey, GETX_FOLLOW_CACHE_TTL_MS, async () => {
      const [sourceUser, targetUser] = await Promise.all([
        this.resolveUser(source),
        this.resolveUser(target),
      ]);

      const payload = await this.requestGetX<{
        data?: {
          sourceUserName?: string;
          targetUserName?: string;
          sourceFollowsTarget?: boolean;
          targetFollowsSource?: boolean;
          blocking?: boolean;
          blockedBy?: boolean;
        };
      }>("/twitter/user/check_follow_relationship", {
        query: {
          source_user_name: sourceUser.userName,
          target_user_name: targetUser.userName,
        },
      });

      return {
        verified: payload.data?.sourceFollowsTarget === true,
        sourceUser,
        targetUser,
        raw: payload.data || null,
      };
    });
  }

  async getTweetDetail(tweetId: string) {
    const normalizedId = String(tweetId || "").trim();
    if (!/^\d+$/.test(normalizedId)) {
      throw new Error("A valid X post id is required");
    }

    return runtimeCache.getOrSet(
      `getx:tweet:${normalizedId}`,
      GETX_TWEET_CACHE_TTL_MS,
      async () => {
        const payload = await this.requestGetX<{ data?: GetXTweet }>(
          "/twitter/tweet/detail",
          {
            query: { id: normalizedId },
          }
        );

        if (!payload.data?.id) {
          throw new Error("GetX returned no X post");
        }

        return payload.data;
      }
    );
  }

  invalidateForXUser(userId?: string | null) {
    if (!userId) {
      runtimeCache.invalidatePrefix("getx:");
      return;
    }

    runtimeCache.invalidate(`getx:user:id:${userId}`);
    runtimeCache.invalidatePrefix(`getx:follow:${userId}:`);
  }
}

export const xVerificationService = new XVerificationService();
