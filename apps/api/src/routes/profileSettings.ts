import { Hono, type Context } from "hono";
import {
  ProfileSettingsError,
  profileSettingsService,
  type PfpUploadUrlInput,
  type SaveProfileSettingsInput,
} from "../services/profileSettings";
import { getAuthAddress, isSameAddress } from "../middleware/requireWalletAuth";

const profileSettingsRoutes = new Hono();

function getRequestIp(c: Context) {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const firstForwarded = forwarded.split(",")[0]?.trim();
    if (firstForwarded) {
      return firstForwarded;
    }
  }

  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function isProfileSettingsAdmin(c: Context) {
  const adminToken =
    process.env.PARTNER_ADMIN_TOKEN || process.env.QUEST_ADMIN_TOKEN || "";
  const provided = c.req.header("x-admin-token");
  return adminToken.length > 0 && !!provided && provided === adminToken;
}

type ProfileSettingsStatus = 400 | 401 | 409 | 429 | 500 | 503;

function toProfileSettingsStatus(status: number): ProfileSettingsStatus {
  return status === 400 ||
    status === 401 ||
    status === 409 ||
    status === 429 ||
    status === 503
    ? status
    : 500;
}

function getErrorPayload(error: unknown) {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "Failed to update profile settings";
  const status = toProfileSettingsStatus(
    error instanceof ProfileSettingsError ? error.status : 500
  );

  return {
    status,
    body: {
      success: false,
      error: message,
    },
  } as const;
}

// Strip identity-revealing fields (social handles, IDs, connection timestamps,
// storage keys) from a profile-settings payload, keeping only the public display
// info (name / username / avatar) plus connection booleans. Returned to anyone
// who hasn't proven ownership, so a wallet's pseudonymity can't be scraped.
function toPublicProfileSettings(data: unknown) {
  const payload = data as { profile?: Record<string, unknown> } | null;
  if (!payload || typeof payload !== "object" || !payload.profile) {
    return data;
  }

  const p = payload.profile as Record<string, any>;
  const discord = p.discordAccount as Record<string, any> | null | undefined;

  return {
    ...payload,
    savedXUsername: null,
    profile: {
      ...p,
      discordUsername: null,
      pfpStorageKey: null,
      xUsername: null,
      xUserId: null,
      xName: null,
      xAvatar: null,
      xConnectedAt: null,
      xLegacyManual: false,
      discordAccount: discord
        ? {
            connected: discord.connected ?? false,
            joined: discord.joined ?? false,
            pending: discord.pending ?? null,
          }
        : null,
      custom: p.custom
        ? { ...p.custom, discordUsername: null, pfpStorageKey: null }
        : p.custom,
    },
  };
}

const handleGetProfileSettings = async (c: Context) => {
  try {
    const address = c.req.query("address");
    if (!address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    const data = await profileSettingsService.getProfileSettings(address);

    // The owner (verified session) or the partner-admin tool gets the full
    // payload; everyone else gets only the public display subset.
    const authAddress = getAuthAddress(c);
    const canSeePrivate =
      isProfileSettingsAdmin(c) || isSameAddress(authAddress, address);

    return c.json(canSeePrivate ? data : toPublicProfileSettings(data));
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status);
  }
};

const handleSaveProfileSettings = async (c: Context) => {
  try {
    const body = (await c.req.json()) as SaveProfileSettingsInput;
    const data = await profileSettingsService.saveProfileSettings(
      body,
      getRequestIp(c)
    );

    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status);
  }
};

profileSettingsRoutes.get("/", handleGetProfileSettings);
profileSettingsRoutes.get("", handleGetProfileSettings);
profileSettingsRoutes.post("/", handleSaveProfileSettings);
profileSettingsRoutes.post("", handleSaveProfileSettings);

profileSettingsRoutes.post("/pfp-upload-url", async (c) => {
  try {
    const body = (await c.req.json()) as PfpUploadUrlInput;
    const data = await profileSettingsService.createPfpUploadUrl(
      body,
      getRequestIp(c)
    );

    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status);
  }
});

export { profileSettingsRoutes };
