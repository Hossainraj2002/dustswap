import { Hono } from "hono";
import {
  questEngine,
  type AdminQuestInput,
  type DiscordAccountAuthInput,
  type XAccountAuthInput,
} from "../services/questEngine";
import { pointsEngine } from "../services/pointsEngine";
import { runtimeCache } from "../utils/runtimeCache";
import { DiscordVerificationError } from "../services/discordVerification";
import { isMaintenanceBlocking, maintenanceUnavailable } from "../utils/maintenance";
import { isAllowedAppOrigin } from "../config/appOrigins";

const questsRoutes = new Hono();

function getAdminToken() {
  const token = process.env.QUEST_ADMIN_TOKEN;
  if (!token) {
    throw new Error("QUEST_ADMIN_TOKEN is not configured");
  }
  return token;
}

function assertAdmin(c: any) {
  const expected = getAdminToken();
  const received = c.req.header("x-admin-token");

  if (!received || received !== expected) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  return null;
}

function getDiscordRedirectBase(returnTo?: string | null) {
  const fallback = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  let fallbackUrl: URL;
  try {
    fallbackUrl = new URL("/quests", fallback);
  } catch {
    fallbackUrl = new URL("/quests", "http://localhost:3000");
  }

  if (returnTo) {
    try {
      const redirectUrl = new URL(returnTo, fallbackUrl);
      if (isAllowedAppOrigin(redirectUrl.origin)) {
        return redirectUrl;
      }
    } catch {
      return fallbackUrl;
    }
  }

  return fallbackUrl;
}

function getDiscordCallbackReturnTo(error: unknown) {
  const returnTo =
    error && typeof error === "object"
      ? (error as { returnTo?: unknown }).returnTo
      : null;
  return typeof returnTo === "string" ? returnTo : null;
}

function getDiscordErrorPayload(error: unknown) {
  if (error instanceof DiscordVerificationError) {
    return {
      status: error.status as 200 | 400 | 429 | 503,
      body: {
        success: false,
        connected: error.code !== "DISCORD_NOT_CONNECTED",
        joined: false,
        error: error.code,
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
      },
    };
  }

  return {
    status: 400 as const,
    body: {
      success: false,
      connected: false,
      joined: false,
      error: "DISCORD_VERIFY_FAILED",
      message: (error as Error).message || "Discord verification failed",
    },
  };
}

questsRoutes.get("/", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const address = c.req.query("address") || undefined;
    const data = await questEngine.getQuestBoard(address);
    return c.json({ success: true, ...data });
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      500
    );
  }
});

questsRoutes.get("/admin", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const data = await questEngine.listAdminQuests();
    return c.json({ success: true, data });
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      500
    );
  }
});

questsRoutes.post("/admin", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const body = (await c.req.json()) as AdminQuestInput;
    const data = await questEngine.saveQuest(body);
    return c.json({ success: true, data });
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.get("/admin/campaigns/:key/whitelist", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const data = await questEngine.listCampaignWhitelist(c.req.param("key"));
    return c.json({ success: true, data });
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      500
    );
  }
});

questsRoutes.post("/admin/manual-points", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const body = (await c.req.json()) as {
      entries?: Array<{ address?: string; points?: number }>;
      note?: string;
      requestId?: string;
      source?: string;
    };

    const data = await pointsEngine.awardAdminPointsBatch({
      entries: Array.isArray(body.entries)
        ? body.entries.map((entry) => ({
            address: String(entry.address || ""),
            points: Number(entry.points || 0),
          }))
        : [],
      note: body.note,
      requestId: body.requestId,
      source: body.source || "quest_admin_console",
    });

    return c.json({ success: true, data });
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.delete("/admin/:id", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const data = await questEngine.deleteQuest(c.req.param("id"));
    return c.json(data);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.post("/x/username", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  return c.json(
    {
      success: false,
      error: "Manual X username linking is deprecated. Connect X with OAuth.",
    },
    410
  );
});

questsRoutes.get("/x/account", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const address = c.req.query("address");
    if (!address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    const data = await questEngine.getXAccount(address);
    return c.json(data);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.post("/x/connect", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const body = (await c.req.json()) as XAccountAuthInput;
    const authUrl = await questEngine.createXAuthUrl(body);
    return c.json({ success: true, authUrl });
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.get("/x/connect", async (c) => {
  return c.json(
    {
      success: false,
      error: "Use signed POST /api/quests/x/connect to connect X.",
    },
    405
  );
});

questsRoutes.post("/x/disconnect", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const body = (await c.req.json()) as XAccountAuthInput;
    const data = await questEngine.disconnectXAccount(body);
    return c.json(data);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.get("/x/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.text("Missing X callback params", 400);
  }

  try {
    const result = await questEngine.handleXCallback(code, state);
    const redirectUrl = new URL(result.returnTo);
    redirectUrl.searchParams.set("x_linked", "1");
    redirectUrl.searchParams.set("x_username", result.username);
    return c.redirect(redirectUrl.toString(), 302);
  } catch (error) {
    const fallback = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const redirectUrl = new URL("/quests", fallback);
    redirectUrl.searchParams.set("x_linked", "0");
    redirectUrl.searchParams.set("x_error", (error as Error).message);
    return c.redirect(redirectUrl.toString(), 302);
  }
});

questsRoutes.get("/discord/connect", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const input: DiscordAccountAuthInput = {
      address: c.req.query("address"),
      message: c.req.query("message"),
      signature: c.req.query("signature") as DiscordAccountAuthInput["signature"],
      returnTo: c.req.query("returnTo"),
    };
    const authUrl = await questEngine.createDiscordAuthUrl(input);
    return c.redirect(authUrl, 302);
  } catch (error) {
    const redirectUrl = getDiscordRedirectBase(c.req.query("returnTo"));
    redirectUrl.searchParams.set("discord_linked", "0");
    redirectUrl.searchParams.set(
      "discord_error",
      error instanceof DiscordVerificationError
        ? error.code
        : "DISCORD_OAUTH_STATE_INVALID"
    );
    return c.redirect(redirectUrl.toString(), 302);
  }
});

questsRoutes.get("/discord/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    const redirectUrl = getDiscordRedirectBase();
    redirectUrl.searchParams.set("discord_linked", "0");
    redirectUrl.searchParams.set("discord_error", "DISCORD_OAUTH_STATE_INVALID");
    return c.redirect(redirectUrl.toString(), 302);
  }

  try {
    const result = await questEngine.handleDiscordCallback(code, state);
    const redirectUrl = new URL(result.returnTo);
    redirectUrl.searchParams.set("discord_linked", "1");
    redirectUrl.searchParams.set(
      "discord_username",
      result.displayName || result.username
    );
    return c.redirect(redirectUrl.toString(), 302);
  } catch (error) {
    const redirectUrl = getDiscordRedirectBase(getDiscordCallbackReturnTo(error));
    redirectUrl.searchParams.set("discord_linked", "0");
    redirectUrl.searchParams.set(
      "discord_error",
      error instanceof DiscordVerificationError
        ? error.code
        : "DISCORD_OAUTH_EXCHANGE_FAILED"
    );
    return c.redirect(redirectUrl.toString(), 302);
  }
});

questsRoutes.post("/discord/verify", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const body = (await c.req.json()) as {
      address?: string;
      questId?: string | null;
    };

    if (!body.address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    const data = await questEngine.verifyDiscordGuildMembership(
      body.address,
      body.questId
    );
    return c.json(data);
  } catch (error) {
    const payload = getDiscordErrorPayload(error);
    return c.json(payload.body, payload.status);
  }
});

questsRoutes.post("/activities/swap", async (c) => {
  try {
    const body = (await c.req.json()) as {
      address?: string;
      txHash?: string;
      chainId?: number | string;
      amountUsd?: number;
      inputToken?: string | null;
      outputToken?: string | null;
      metadata?: Record<string, unknown>;
    };

    if (!body.address || !body.txHash || body.chainId == null) {
      return c.json(
        { success: false, error: "address, txHash, and chainId are required" },
        400
      );
    }

    const parsedChainId =
      typeof body.chainId === "string" ? Number(body.chainId) : body.chainId;
    if (!Number.isFinite(parsedChainId)) {
      return c.json({ success: false, error: "A valid chainId is required" }, 400);
    }

    const data = await questEngine.recordSwapActivity({
      address: body.address,
      txHash: body.txHash,
      chainId: parsedChainId,
      amountUsd: Number(body.amountUsd || 0),
      inputToken: body.inputToken,
      outputToken: body.outputToken,
      metadata: body.metadata,
    });

    return c.json(data);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.post("/activities/swap/sync", async (c) => {
  try {
    const body = (await c.req.json()) as { address?: string; force?: boolean };

    if (!body.address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    const data = await questEngine.syncRecentSwapActivity(body.address, {
      force: Boolean(body.force),
    });
    return c.json(data);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.post("/:id/start", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const body = (await c.req.json()) as { address?: string };
    if (!body.address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    const questId = c.req.param("id");
    const normalizedAddress = body.address.trim().toLowerCase();
    const questStartRateLimit = runtimeCache.consumeRateLimit(
      `quests:start:cooldown:${normalizedAddress}:${questId}`,
      4,
      10_000
    );

    if (!questStartRateLimit.allowed) {
      return c.json(
        {
          success: false,
          error: "Quest start is cooling down. Please wait a few seconds.",
        },
        429
      );
    }

    const data = await questEngine.startDelayQuest(body.address, questId);
    return c.json(data);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.post("/:id/verify-delay", async (c) => {
  try {
    const body = (await c.req.json()) as { address?: string };
    if (!body.address) {
      return c.json({ success: false, error: "address is required" }, 400);
    }

    const data = await questEngine.verifyDelayQuest(body.address, c.req.param("id"));
    return c.json(data, data.success ? 200 : 202);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.post("/:id/verify-x-post", async (c) => {
  try {
    const body = (await c.req.json()) as { address?: string; postUrl?: string };
    if (!body.address || !body.postUrl) {
      return c.json(
        { success: false, error: "address and postUrl are required" },
        400
      );
    }

    const data = await questEngine.verifyXPost(
      body.address,
      c.req.param("id"),
      body.postUrl
    );
    return c.json(data);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

export { questsRoutes };
