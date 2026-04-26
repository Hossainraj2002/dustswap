import { Hono, type Context } from "hono";
import {
  ProfileSettingsError,
  profileSettingsService,
  type PfpUploadUrlInput,
  type SaveProfileSettingsInput,
} from "../services/profileSettings";

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

const handleGetProfileSettings = async (c: Context) => {
  try {
    const address = c.req.query("address");
    if (!address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    const data = await profileSettingsService.getProfileSettings(address);
    return c.json(data);
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
