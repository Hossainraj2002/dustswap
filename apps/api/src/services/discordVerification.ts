import { runtimeCache } from "../utils/runtimeCache";
import { supabase } from "./supabase";

export type DiscordSocialAccountRecord = {
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

export type DiscordUserProfile = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

export type DiscordTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

export type DiscordMembershipResult = {
  memberPresent: boolean;
  joined: boolean;
  pending: boolean | null;
  roles: string[];
  joinedAt: string | null;
  verifiedAt: string;
  guildId: string;
};

export class DiscordVerificationError extends Error {
  constructor(
    readonly code:
      | "DISCORD_NOT_CONFIGURED"
      | "DISCORD_NOT_CONNECTED"
      | "DISCORD_OAUTH_STATE_INVALID"
      | "DISCORD_OAUTH_EXCHANGE_FAILED"
      | "DISCORD_USER_FETCH_FAILED"
      | "DISCORD_BOT_TOKEN_INVALID"
      | "DISCORD_BOT_NOT_IN_GUILD_OR_FORBIDDEN"
      | "DISCORD_USER_NOT_IN_GUILD"
      | "DISCORD_RATE_LIMITED"
      | "DISCORD_VERIFY_FAILED",
    message: string,
    readonly status = 400,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_TIMEOUT_MS = Math.min(
  20_000,
  Math.max(1_000, Number(process.env.DISCORD_TIMEOUT_MS || "8000"))
);
const DISCORD_MEMBERSHIP_CACHE_TTL_MS = Math.min(
  15 * 60 * 1000,
  Math.max(30_000, Number(process.env.DISCORD_MEMBERSHIP_CACHE_TTL_MS || "300000"))
);

function safeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseRetryAfterSeconds(response: Response, payload: unknown) {
  const headerValue = Number(response.headers.get("retry-after") || "");
  if (Number.isFinite(headerValue) && headerValue > 0) {
    return headerValue;
  }

  if (payload && typeof payload === "object") {
    const retryAfter = Number((payload as { retry_after?: unknown }).retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter;
    }
  }

  return 60;
}

async function parseJsonSafely(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

export function getDiscordClientId() {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  if (!clientId) {
    throw new DiscordVerificationError(
      "DISCORD_NOT_CONFIGURED",
      "Discord is not configured.",
      503
    );
  }

  return clientId;
}

export function getDiscordClientSecret() {
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new DiscordVerificationError(
      "DISCORD_NOT_CONFIGURED",
      "Discord is not configured.",
      503
    );
  }

  return clientSecret;
}

export function getDiscordRedirectUri() {
  const redirectUri = process.env.DISCORD_REDIRECT_URI?.trim();
  if (!redirectUri) {
    throw new DiscordVerificationError(
      "DISCORD_NOT_CONFIGURED",
      "Discord is not configured.",
      503
    );
  }

  return redirectUri;
}

export function getDiscordGuildId() {
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  if (!guildId) {
    throw new DiscordVerificationError(
      "DISCORD_NOT_CONFIGURED",
      "Discord is not configured.",
      503
    );
  }

  return guildId;
}

function getDiscordBotToken() {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    throw new DiscordVerificationError(
      "DISCORD_NOT_CONFIGURED",
      "Discord verification is temporarily unavailable.",
      503
    );
  }

  return token;
}

export function buildDiscordAvatarUrl(user: DiscordUserProfile) {
  if (!user.avatar) {
    return null;
  }

  const extension = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
}

export function toDiscordAccountSummary(account: DiscordSocialAccountRecord | null) {
  if (!account) {
    return null;
  }

  const metadata = safeMetadata(account.metadata);
  const joined = metadata.joined === true;
  const pending =
    typeof metadata.pending === "boolean" ? metadata.pending : null;

  return {
    username: account.username,
    platformUserId: account.platform_user_id,
    discordUserId: account.platform_user_id,
    displayName: account.display_name,
    profileImageUrl: account.profile_image_url,
    connected: true,
    connectedAt:
      (typeof metadata.connectedAt === "string" && metadata.connectedAt) ||
      null,
    guildId:
      (typeof metadata.guildId === "string" && metadata.guildId) ||
      null,
    joined,
    pending,
    joinedAt:
      (typeof metadata.joinedAt === "string" && metadata.joinedAt) ||
      null,
    verifiedAt:
      (typeof metadata.verifiedAt === "string" && metadata.verifiedAt) ||
      null,
    roles: Array.isArray(metadata.roles)
      ? metadata.roles.map((role) => String(role))
      : [],
  };
}

export class DiscordVerificationService {
  async exchangeCodeForToken(code: string) {
    const body = new URLSearchParams({
      client_id: getDiscordClientId(),
      client_secret: getDiscordClientSecret(),
      grant_type: "authorization_code",
      code,
      redirect_uri: getDiscordRedirectUri(),
    });

    const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new DiscordVerificationError(
        "DISCORD_OAUTH_EXCHANGE_FAILED",
        "Discord connection failed. Please try again.",
        400
      );
    }

    const payload = (await response.json()) as Partial<DiscordTokenResponse>;
    if (!payload.access_token) {
      throw new DiscordVerificationError(
        "DISCORD_OAUTH_EXCHANGE_FAILED",
        "Discord connection failed. Please try again.",
        400
      );
    }

    return payload as DiscordTokenResponse;
  }

  async fetchCurrentUser(accessToken: string) {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new DiscordVerificationError(
        "DISCORD_USER_FETCH_FAILED",
        "Could not load your Discord profile. Please try again.",
        400
      );
    }

    const payload = (await response.json()) as Partial<DiscordUserProfile>;
    if (!payload.id || !payload.username) {
      throw new DiscordVerificationError(
        "DISCORD_USER_FETCH_FAILED",
        "Could not load your Discord profile. Please try again.",
        400
      );
    }

    return payload as DiscordUserProfile;
  }

  async getAccountSummary(userId: number) {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", userId)
      .eq("platform", "discord")
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load Discord account: ${error.message}`);
    }

    return toDiscordAccountSummary(
      (data as DiscordSocialAccountRecord | null) ?? null
    );
  }

  async requireConnectedAccount(userId: number) {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", userId)
      .eq("platform", "discord")
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load Discord account: ${error.message}`);
    }

    const account = (data as DiscordSocialAccountRecord | null) ?? null;
    if (!account?.platform_user_id) {
      throw new DiscordVerificationError(
        "DISCORD_NOT_CONNECTED",
        "Connect Discord first.",
        200
      );
    }

    return account;
  }

  async checkGuildMembership(discordUserId: string) {
    const normalizedUserId = String(discordUserId || "").trim();
    if (!/^\d{5,32}$/.test(normalizedUserId)) {
      throw new DiscordVerificationError(
        "DISCORD_VERIFY_FAILED",
        "Discord verification is temporarily unavailable.",
        400
      );
    }

    const guildId = getDiscordGuildId();
    const cacheKey = `discord:guild-member:${guildId}:${normalizedUserId}`;
    const cached = runtimeCache.get<DiscordMembershipResult>(cacheKey);
    if (cached) {
      return cached;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);

    const response = await fetch(
      `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(
        normalizedUserId
      )}`,
      {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bot ${getDiscordBotToken()}`,
        },
      }
    ).finally(() => clearTimeout(timeoutId));

    const payload = await parseJsonSafely(response);
    const verifiedAt = new Date().toISOString();

    if (response.status === 200) {
      const member = payload as {
        roles?: unknown[];
        pending?: boolean;
        joined_at?: string | null;
      } | null;
      const pending = member?.pending === true;
      const result = {
        memberPresent: true,
        joined: !pending,
        pending,
        roles: Array.isArray(member?.roles)
          ? member!.roles.map((role) => String(role))
          : [],
        joinedAt:
          typeof member?.joined_at === "string" ? member.joined_at : null,
        verifiedAt,
        guildId,
      } satisfies DiscordMembershipResult;

      runtimeCache.set(cacheKey, result, DISCORD_MEMBERSHIP_CACHE_TTL_MS);
      return result;
    }

    if (response.status === 404) {
      return {
        memberPresent: false,
        joined: false,
        pending: null,
        roles: [],
        joinedAt: null,
        verifiedAt,
        guildId,
      } satisfies DiscordMembershipResult;
    }

    if (response.status === 401) {
      throw new DiscordVerificationError(
        "DISCORD_BOT_TOKEN_INVALID",
        "Discord verification is temporarily unavailable.",
        503
      );
    }

    if (response.status === 403) {
      throw new DiscordVerificationError(
        "DISCORD_BOT_NOT_IN_GUILD_OR_FORBIDDEN",
        "Discord verification is temporarily unavailable.",
        503
      );
    }

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response, payload);
      throw new DiscordVerificationError(
        "DISCORD_RATE_LIMITED",
        "Verification is rate limited. Try again shortly.",
        429,
        retryAfterSeconds
      );
    }

    throw new DiscordVerificationError(
      "DISCORD_VERIFY_FAILED",
      "Discord verification is temporarily unavailable.",
      503
    );
  }

  async updateMembershipMetadata(
    account: DiscordSocialAccountRecord,
    membership: DiscordMembershipResult
  ) {
    const metadata = safeMetadata(account.metadata);
    const nextMetadata = {
      ...metadata,
      source: "discord_oauth_bot_check",
      guildId: membership.guildId,
      memberPresent: membership.memberPresent,
      joined: membership.joined,
      pending: membership.pending,
      roles: membership.roles,
      joinedAt: membership.joinedAt,
      verifiedAt: membership.verifiedAt,
    };

    const { error } = await supabase
      .from("social_accounts")
      .update({
        metadata: nextMetadata,
        updated_at: membership.verifiedAt,
      })
      .eq("id", account.id);

    if (error) {
      throw new Error(`Failed to save Discord verification: ${error.message}`);
    }
  }
}

export const discordVerificationService = new DiscordVerificationService();
