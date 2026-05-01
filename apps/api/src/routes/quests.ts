import { Hono, type Context } from "hono";
import { questEngine, type AdminQuestInput } from "../services/questEngine";
import { pointsEngine } from "../services/pointsEngine";
import { runtimeCache } from "../utils/runtimeCache";

const questsRoutes = new Hono();
const MAINTENANCE_ERROR_MESSAGE =
  "DustSwap is under maintenance. Please try again soon.";

function isMaintenanceModeEnabled() {
  return process.env.MAINTENANCE_MODE === "1";
}

function maintenanceUnavailable(c: Context) {
  return c.json({ success: false, error: MAINTENANCE_ERROR_MESSAGE }, 503);
}

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

questsRoutes.get("/", async (c) => {
  if (isMaintenanceModeEnabled()) {
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
  if (isMaintenanceModeEnabled()) {
    return maintenanceUnavailable(c);
  }

  try {
    const body = (await c.req.json()) as {
      address?: string;
      username?: string;
    };

    if (!body.address || !body.username) {
      return c.json(
        { success: false, error: "address and username are required" },
        400
      );
    }

    const normalizedAddress = body.address.trim().toLowerCase();
    const usernameRateLimit = runtimeCache.consumeRateLimit(
      `quests:x-username:cooldown:${normalizedAddress}`,
      4,
      10_000
    );

    if (!usernameRateLimit.allowed) {
      return c.json(
        {
          success: false,
          error: "X username save is cooling down. Please wait a few seconds.",
        },
        429
      );
    }

    const guardKey = `quests:x-username:${normalizedAddress}:${body.username
      .trim()
      .toLowerCase()}`;
    const data = await runtimeCache.singleFlight(guardKey, () =>
      questEngine.saveManualXUsername(body.address!, body.username!)
    );
    return c.json(data);
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      400
    );
  }
});

questsRoutes.get("/x/connect", async (c) => {
  const address = c.req.query("address");
  const returnTo = c.req.query("returnTo") || `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/quests`;
  const format = c.req.query("format");

  if (!address) {
    return c.json({ success: false, error: "address is required" }, 400);
  }

  try {
    const authUrl = await questEngine.createXAuthUrl(address, returnTo);
    if (format === "json") {
      return c.json({ success: true, authUrl });
    }
    return c.redirect(authUrl, 302);
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
  if (isMaintenanceModeEnabled()) {
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
