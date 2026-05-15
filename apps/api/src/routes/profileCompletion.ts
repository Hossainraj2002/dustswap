import { Hono, type Context } from "hono";
import {
  ProfileCompletionError,
  profileCompletionService,
  type ProfileCompletionAuthInput,
} from "../services/profileCompletion";

const profileCompletionRoutes = new Hono();

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

function getErrorPayload(error: unknown) {
  const status =
    error instanceof ProfileCompletionError ? error.status : 500;
  const message =
    error instanceof Error && error.message
      ? error.message
      : "Profile completion request failed";

  return {
    status,
    body: {
      success: false,
      error: message,
    },
  } as const;
}

const handleGetGuide = async (c: Context) => {
  try {
    const address = c.req.query("address");
    if (!address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    const data = await profileCompletionService.getGuide(address);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 429 | 500);
  }
};

profileCompletionRoutes.get("/", handleGetGuide);
profileCompletionRoutes.get("", handleGetGuide);

profileCompletionRoutes.post("/impression", async (c) => {
  try {
    const body = await c.req.json<{
      address?: string;
      surface?: "tracker" | "modal" | null;
    }>();

    const data = await profileCompletionService.recordImpression(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 429 | 500);
  }
});

profileCompletionRoutes.post("/dismiss", async (c) => {
  try {
    const body = await c.req.json<{ address?: string }>();
    const data = await profileCompletionService.dismiss(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 429 | 500);
  }
});

profileCompletionRoutes.post("/claim", async (c) => {
  try {
    const body = (await c.req.json()) as ProfileCompletionAuthInput;
    const data = await profileCompletionService.claimReward(
      body,
      getRequestIp(c)
    );

    if (!data.success) {
      return c.json(data, 409);
    }

    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 429 | 500);
  }
});

export { profileCompletionRoutes };
