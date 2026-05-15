import { createHash, randomBytes } from "crypto";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getAddress, isAddress, type Hex } from "viem";
import { pointsEngine } from "./pointsEngine";
import { postgresDb } from "./postgres";
import { isAllowedAppDomain } from "../config/appOrigins";
import { createBasePublicClient } from "../utils/baseRpc";
import { runtimeCache } from "../utils/runtimeCache";
import {
  isConnectedXAccount,
  toXAccountSummary,
  type XSocialAccountRecord,
} from "./xVerification";
import {
  toDiscordAccountSummary,
  type DiscordSocialAccountRecord,
} from "./discordVerification";

const PROFILE_SIGNATURE_TTL_MS = 5 * 60 * 1000;
const PROFILE_SIGNATURE_FUTURE_SKEW_MS = 60 * 1000;
const PROFILE_WRITE_WINDOW_MS = 60 * 1000;
const PROFILE_WRITE_LIMIT = 8;
const PFP_UPLOAD_WINDOW_MS = 60 * 1000;
const PFP_UPLOAD_LIMIT = 8;
const MAX_PFP_BYTES = 1024 * 1024;
const SIGNED_UPLOAD_EXPIRES_SECONDS = 5 * 60;
const ALLOWED_PFP_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const ALLOWED_PFP_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const PROFILE_SETTINGS_STATEMENT = "DustSwap Profile Settings";

type SocialAccountRecord = {
  id?: number;
  user_id: number;
  platform?: string;
  platform_user_id: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  metadata?: Record<string, unknown> | null;
  updated_at?: string | null;
};

type UserProfileRecord = {
  user_id: number;
  username: string | null;
  display_name: string | null;
  discord_username: string | null;
  pfp_url: string | null;
  pfp_storage_key: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type UserRecord = {
  id: number;
  address: string;
};

export type ProfileSettingsResponse = {
  address: string;
  username: string | null;
  displayName: string | null;
  discordUsername: string | null;
  pfpUrl: string | null;
  pfpStorageKey: string | null;
  xUsername: string | null;
  xUserId: string | null;
  xName: string | null;
  xAvatar: string | null;
  xConnected: boolean;
  xConnectedAt: string | null;
  xLegacyManual: boolean;
  discordAccount: ReturnType<typeof toDiscordAccountSummary>;
  source: "custom" | "fallback" | "wallet";
  custom: {
    username: string | null;
    displayName: string | null;
    discordUsername: string | null;
    pfpUrl: string | null;
    pfpStorageKey: string | null;
  };
  fallback: {
    username: string | null;
    displayName: string | null;
    pfpUrl: string | null;
  };
};

export type ProfileSettingsAuthInput = {
  address?: string;
  message?: string;
  signature?: Hex;
};

export type SaveProfileSettingsInput = ProfileSettingsAuthInput & {
  username?: string | null;
  displayName?: string | null;
  discordUsername?: string | null;
  pfpUrl?: string | null;
  pfpStorageKey?: string | null;
  xUsername?: string | null;
};

export type PfpUploadUrlInput = ProfileSettingsAuthInput & {
  fileName?: string;
  contentType?: string;
  size?: number;
};

type AuthenticatedProfileAction = {
  address: string;
  action: "save-profile" | "pfp-upload-url";
};

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicBaseUrl: string;
  region: string;
};

type R2ConfigStatus =
  | {
      available: true;
      config: R2Config;
      missingEnvVars: [];
    }
  | {
      available: false;
      config: null;
      missingEnvVars: string[];
    };

export class ProfileSettingsError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

const publicClient = createBasePublicClient();

function normalizeAddress(address: string) {
  if (!isAddress(address)) {
    throw new ProfileSettingsError("A valid wallet address is required", 400);
  }

  return getAddress(address).toLowerCase();
}

function normalizeOptionalProfileUsername(value: unknown) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (!/^[a-z0-9._]{3,24}$/.test(normalized)) {
    throw new ProfileSettingsError(
      "Username can use letters, numbers, underscore, or dot.",
      400
    );
  }

  return normalized;
}

function normalizeOptionalDisplayName(value: unknown) {
  if (value == null) {
    return null;
  }

  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized) {
    return null;
  }

  if (normalized.length < 2 || normalized.length > 32) {
    throw new ProfileSettingsError("Display name must be 2-32 characters.", 400);
  }

  return normalized;
}

function normalizeOptionalDiscordUsername(value: unknown) {
  if (value == null) {
    return null;
  }

  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized) {
    return null;
  }

  if (normalized.length < 2 || normalized.length > 40) {
    throw new ProfileSettingsError("Discord username must be 2-40 characters.", 400);
  }

  return normalized;
}

function toStoredXUsername(value: string | null | undefined) {
  const normalized = String(value || "").trim().replace(/^@+/, "");
  return normalized || null;
}

function parseProfileSettingsMessage(message: string) {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== PROFILE_SETTINGS_STATEMENT) {
    throw new ProfileSettingsError("Invalid profile settings message.", 401);
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

function getR2ConfigStatus(): R2ConfigStatus {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucketName = process.env.R2_BUCKET_NAME?.trim();
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const missingEnvVars = [
    !accountId ? "R2_ACCOUNT_ID" : null,
    !accessKeyId ? "R2_ACCESS_KEY_ID" : null,
    !secretAccessKey ? "R2_SECRET_ACCESS_KEY" : null,
    !bucketName ? "R2_BUCKET_NAME" : null,
    !publicBaseUrl ? "R2_PUBLIC_BASE_URL" : null,
  ].filter((value): value is string => Boolean(value));

  if (missingEnvVars.length > 0) {
    return {
      available: false,
      config: null,
      missingEnvVars,
    };
  }

  return {
    available: true,
    config: {
      accountId: accountId!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      bucketName: bucketName!,
      publicBaseUrl: publicBaseUrl!,
      region: process.env.R2_REGION?.trim() || "auto",
    },
    missingEnvVars: [],
  };
}

function getR2Config(): R2Config | null {
  return getR2ConfigStatus().config;
}

function getR2Client(config: R2Config) {
  return new S3Client({
    region: config.region,
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function normalizeContentType(contentType: unknown) {
  const normalized = String(contentType || "").split(";")[0]?.trim().toLowerCase() || "";
  if (!ALLOWED_PFP_CONTENT_TYPES.has(normalized)) {
    throw new ProfileSettingsError("Only PNG, JPG, JPEG, or WEBP allowed.", 400);
  }

  return normalized;
}

function getFileExtension(fileName: unknown, contentType: string) {
  const name = String(fileName || "").trim().toLowerCase();
  const candidate = name.includes(".") ? name.split(".").pop() || "" : "";
  const extension =
    ALLOWED_PFP_EXTENSIONS.has(candidate)
      ? candidate
      : contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
          ? "webp"
          : "jpg";

  if (!ALLOWED_PFP_EXTENSIONS.has(extension)) {
    throw new ProfileSettingsError("Only PNG, JPG, JPEG, or WEBP allowed.", 400);
  }

  return extension;
}

function assertPfpSize(size: unknown) {
  const parsed = Number(size);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProfileSettingsError("A valid image size is required.", 400);
  }

  if (parsed > MAX_PFP_BYTES) {
    throw new ProfileSettingsError("Image must be under 1 MB.", 400);
  }

  return parsed;
}

function getPfpStoragePrefix(address: string) {
  return `profile-pfps/${address.toLowerCase()}/`;
}

function isMissingUserProfilesTable(error: { code?: string; message?: string } | null) {
  if (!error) {
    return false;
  }

  const message = String(error.message || "").toLowerCase();
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    (message.includes("user_profiles") && message.includes("schema cache"))
  );
}

function buildProfileResponse(args: {
  address: string;
  custom: UserProfileRecord | null;
  fallback: SocialAccountRecord | null;
  xAccount: SocialAccountRecord | null;
  discordAccount: SocialAccountRecord | null;
}): ProfileSettingsResponse {
  const custom = args.custom;
  const fallback = args.fallback;
  const customHasDisplayValue = Boolean(
    custom?.username || custom?.display_name || custom?.pfp_url
  );
  const fallbackHasDisplayValue = Boolean(
    fallback?.username || fallback?.display_name || fallback?.profile_image_url
  );

  const username = custom?.username || fallback?.username || null;
  const displayName =
    custom?.display_name ||
    custom?.username ||
    fallback?.display_name ||
    fallback?.username ||
    null;
  const xSummary = toXAccountSummary(args.xAccount as XSocialAccountRecord | null);
  const discordSummary = toDiscordAccountSummary(
    args.discordAccount as DiscordSocialAccountRecord | null
  );

  return {
    address: args.address,
    username,
    displayName,
    discordUsername: custom?.discord_username || null,
    pfpUrl: custom?.pfp_url || fallback?.profile_image_url || null,
    pfpStorageKey: custom?.pfp_storage_key || null,
    xUsername: toStoredXUsername(xSummary?.username || args.xAccount?.username),
    xUserId: xSummary?.xUserId || null,
    xName: xSummary?.displayName || null,
    xAvatar: xSummary?.profileImageUrl || null,
    xConnected: xSummary?.connected === true,
    xConnectedAt: xSummary?.connectedAt || null,
    xLegacyManual: xSummary?.legacyManual === true,
    discordAccount: discordSummary,
    source: customHasDisplayValue ? "custom" : fallbackHasDisplayValue ? "fallback" : "wallet",
    custom: {
      username: custom?.username || null,
      displayName: custom?.display_name || null,
      discordUsername: custom?.discord_username || null,
      pfpUrl: custom?.pfp_url || null,
      pfpStorageKey: custom?.pfp_storage_key || null,
    },
    fallback: {
      username: fallback?.username || null,
      displayName: fallback?.display_name || null,
      pfpUrl: fallback?.profile_image_url || null,
    },
  };
}

export class ProfileSettingsService {
  isPfpUploadAvailable() {
    return getR2ConfigStatus().available;
  }

  async getProfileSettings(address: string) {
    const normalizedAddress = normalizeAddress(address);
    const { data: userData, error: userError } = await postgresDb
      .from("users")
      .select("id, address")
      .eq("address", normalizedAddress)
      .maybeSingle();

    if (userError) {
      throw new ProfileSettingsError(`Failed to load user profile: ${userError.message}`, 500);
    }

    const user = (userData as UserRecord | null) ?? null;
    let custom: UserProfileRecord | null = null;
    let fallback: SocialAccountRecord | null = null;
    let xAccount: SocialAccountRecord | null = null;
    let discordAccount: SocialAccountRecord | null = null;

    if (user) {
      const [
        { data: customData, error: customError },
        { data: socialData, error: socialError },
      ] = await Promise.all([
        postgresDb.from("user_profiles").select("*").eq("user_id", user.id).maybeSingle(),
        postgresDb
          .from("social_accounts")
          .select(
            "id, user_id, platform_user_id, username, display_name, profile_image_url, metadata, updated_at, platform"
          )
          .eq("user_id", user.id)
          .in("platform", ["farcaster", "x", "discord"]),
      ]);

      if (customError) {
        if (isMissingUserProfilesTable(customError)) {
          console.warn(
            `[ProfileSettings] user_profiles table is not available yet: ${customError.message}`
          );
        } else {
          throw new ProfileSettingsError(
            `Failed to load custom profile: ${customError.message}`,
            500
          );
        }
      }

      if (socialError) {
        throw new ProfileSettingsError(
          `Failed to load profile fallbacks: ${socialError.message}`,
          500
        );
      }

      custom = (customData as UserProfileRecord | null) ?? null;
      const socialRows = (socialData ?? []) as Array<SocialAccountRecord & { platform: string }>;
      const farcasterAccount =
        socialRows.find((row) => row.platform === "farcaster") ?? null;
      xAccount = socialRows.find((row) => row.platform === "x") ?? null;
      discordAccount = socialRows.find((row) => row.platform === "discord") ?? null;
      fallback =
        xAccount && isConnectedXAccount(xAccount as XSocialAccountRecord)
          ? xAccount
          : farcasterAccount;
    }

    const r2Status = getR2ConfigStatus();

    return {
      success: true,
      profile: buildProfileResponse({
        address: normalizedAddress,
        custom,
        fallback,
        xAccount,
        discordAccount,
      }),
      capabilities: {
        pfpUploadAvailable: r2Status.available,
        missingR2EnvVars: r2Status.missingEnvVars,
        pfpUploadUnavailableReason: r2Status.available
          ? null
          : "R2 configuration is missing on the API server.",
      },
    } as const;
  }

  async assertAuthenticatedAction(
    input: ProfileSettingsAuthInput,
    expectedAction: AuthenticatedProfileAction["action"],
    requestIp: string
  ): Promise<AuthenticatedProfileAction> {
    if (!input.address || !input.message || !input.signature) {
      throw new ProfileSettingsError("address, message, and signature are required", 400);
    }

    const normalizedAddress = normalizeAddress(input.address);
    const parsed = parseProfileSettingsMessage(input.message);
    const messageAddress = normalizeAddress(parsed.address);

    if (messageAddress !== normalizedAddress) {
      throw new ProfileSettingsError("Profile signature address mismatch.", 401);
    }

    if (parsed.action !== expectedAction) {
      throw new ProfileSettingsError("Invalid profile settings action.", 401);
    }

    if (!parsed.domain || !isAllowedAppDomain(parsed.domain)) {
      throw new ProfileSettingsError("Unexpected profile settings domain.", 401);
    }

    if (!parsed.nonce || parsed.nonce.length < 8 || parsed.nonce.length > 128) {
      throw new ProfileSettingsError("Invalid profile settings nonce.", 401);
    }

    const timestampMs = Date.parse(parsed.timestamp);
    const now = Date.now();
    if (!Number.isFinite(timestampMs)) {
      throw new ProfileSettingsError("Invalid profile settings timestamp.", 401);
    }

    if (now - timestampMs > PROFILE_SIGNATURE_TTL_MS) {
      throw new ProfileSettingsError("Expired profile settings signature.", 401);
    }

    if (timestampMs - now > PROFILE_SIGNATURE_FUTURE_SKEW_MS) {
      throw new ProfileSettingsError("Invalid profile settings timestamp.", 401);
    }

    const rateLimit = runtimeCache.consumeRateLimit(
      `profile-settings:${expectedAction}:rate:${normalizedAddress}:${requestIp}`,
      expectedAction === "pfp-upload-url" ? PFP_UPLOAD_LIMIT : PROFILE_WRITE_LIMIT,
      expectedAction === "pfp-upload-url" ? PFP_UPLOAD_WINDOW_MS : PROFILE_WRITE_WINDOW_MS
    );

    if (!rateLimit.allowed) {
      throw new ProfileSettingsError("Profile settings is cooling down. Please wait.", 429);
    }

    const replayKey = `profile-settings:replay:${createHash("sha256")
      .update(`${input.message}|${input.signature.toLowerCase()}`)
      .digest("hex")}`;

    if (runtimeCache.get(replayKey)) {
      throw new ProfileSettingsError("Profile settings signature was already used.", 401);
    }

    const valid = await publicClient.verifyMessage({
      address: normalizedAddress as `0x${string}`,
      message: input.message,
      signature: input.signature,
    });

    if (!valid) {
      throw new ProfileSettingsError("Invalid profile settings signature.", 401);
    }

    runtimeCache.set(replayKey, true, PROFILE_SIGNATURE_TTL_MS);

    return {
      address: normalizedAddress,
      action: expectedAction,
    };
  }

  async createPfpUploadUrl(input: PfpUploadUrlInput, requestIp: string) {
    const auth = await this.assertAuthenticatedAction(input, "pfp-upload-url", requestIp);
    const config = getR2Config();

    if (!config) {
      const missingEnvVars = getR2ConfigStatus().missingEnvVars.join(", ");
      throw new ProfileSettingsError(
        `PFP upload is temporarily unavailable. Missing API env: ${missingEnvVars}`,
        503
      );
    }

    const size = assertPfpSize(input.size);
    const contentType = normalizeContentType(input.contentType);
    const extension = getFileExtension(input.fileName, contentType);
    const storageKey = `${getPfpStoragePrefix(auth.address)}avatar-${Date.now()}-${randomBytes(8).toString("hex")}.${extension}`;
    const publicUrl = `${config.publicBaseUrl}/${storageKey}`;
    const client = getR2Client(config);
    const command = new PutObjectCommand({
      Bucket: config.bucketName,
      Key: storageKey,
      ContentType: contentType,
      ContentLength: size,
    });

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: SIGNED_UPLOAD_EXPIRES_SECONDS,
    });

    return {
      success: true,
      uploadUrl,
      publicUrl,
      storageKey,
    } as const;
  }

  private async assertUploadedPfp(address: string, pfpUrl: string, storageKey: string) {
    const config = getR2Config();
    if (!config) {
      const missingEnvVars = getR2ConfigStatus().missingEnvVars.join(", ");
      throw new ProfileSettingsError(
        `PFP upload is temporarily unavailable. Missing API env: ${missingEnvVars}`,
        503
      );
    }

    if (!storageKey.startsWith(getPfpStoragePrefix(address))) {
      throw new ProfileSettingsError("Invalid PFP storage key.", 400);
    }

    if (`${config.publicBaseUrl}/${storageKey}` !== pfpUrl) {
      throw new ProfileSettingsError("Invalid PFP public URL.", 400);
    }

    const extension = storageKey.split(".").pop()?.toLowerCase() || "";
    if (!ALLOWED_PFP_EXTENSIONS.has(extension)) {
      throw new ProfileSettingsError("Only PNG, JPG, JPEG, or WEBP allowed.", 400);
    }

    const head = await getR2Client(config).send(
      new HeadObjectCommand({
        Bucket: config.bucketName,
        Key: storageKey,
      })
    );
    const contentLength = Number(head.ContentLength || 0);
    const contentType = normalizeContentType(head.ContentType);

    assertPfpSize(contentLength);
    if (!ALLOWED_PFP_CONTENT_TYPES.has(contentType)) {
      throw new ProfileSettingsError("Only PNG, JPG, JPEG, or WEBP allowed.", 400);
    }
  }

  async saveProfileSettings(input: SaveProfileSettingsInput, requestIp: string) {
    const auth = await this.assertAuthenticatedAction(input, "save-profile", requestIp);
    const username =
      input.username !== undefined ? normalizeOptionalProfileUsername(input.username) : undefined;
    const displayName =
      input.displayName !== undefined ? normalizeOptionalDisplayName(input.displayName) : undefined;
    const discordUsername =
      input.discordUsername !== undefined
        ? normalizeOptionalDiscordUsername(input.discordUsername)
        : undefined;
    const nextPfpUrl =
      typeof input.pfpUrl === "string" && input.pfpUrl.trim()
        ? input.pfpUrl.trim()
        : undefined;
    const nextPfpStorageKey =
      typeof input.pfpStorageKey === "string" && input.pfpStorageKey.trim()
        ? input.pfpStorageKey.trim()
        : undefined;

    if (nextPfpUrl || nextPfpStorageKey) {
      if (!nextPfpUrl || !nextPfpStorageKey) {
        throw new ProfileSettingsError("PFP URL and storage key are required together.", 400);
      }

      await this.assertUploadedPfp(auth.address, nextPfpUrl, nextPfpStorageKey);
    }

    const user = await pointsEngine.getOrCreate(auth.address);
    const { data: existingProfile, error: existingProfileError } = await postgresDb
      .from("user_profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingProfileError) {
      throw new ProfileSettingsError(
        `Failed to load custom profile: ${existingProfileError.message}`,
        500
      );
    }

    const existing = (existingProfile as UserProfileRecord | null) ?? null;
    const profilePayload = {
      user_id: user.id,
      username: username !== undefined ? username : existing?.username ?? null,
      display_name: displayName !== undefined ? displayName : existing?.display_name ?? null,
      discord_username:
        discordUsername !== undefined
          ? discordUsername
          : existing?.discord_username ?? null,
      pfp_url: nextPfpUrl ?? existing?.pfp_url ?? null,
      pfp_storage_key: nextPfpStorageKey ?? existing?.pfp_storage_key ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await postgresDb
      .from("user_profiles")
      .upsert(profilePayload, {
        onConflict: "user_id",
      });

    if (upsertError) {
      if (upsertError.code === "23505") {
        throw new ProfileSettingsError("Username is already taken.", 409);
      }

      throw new ProfileSettingsError(`Failed to save profile: ${upsertError.message}`, 500);
    }

    pointsEngine.invalidateLeaderboardCache();

    const latest = await this.getProfileSettings(auth.address);
    return {
      ...latest,
      savedXUsername: latest.profile.xUsername,
    } as const;
  }
}

export const profileSettingsService = new ProfileSettingsService();
