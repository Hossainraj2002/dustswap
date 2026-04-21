// apps/api/src/routes/points.ts
// ✅ Fixed: rewritten from Express to Hono (matches the rest of the API)

import { Hono, type Context } from "hono";
import { pointsEngine } from "../services/pointsEngine";
import { runtimeCache } from "../utils/runtimeCache";

const pointsRoutes = new Hono();
const MAINTENANCE_ERROR_MESSAGE =
  "DustSwap is under maintenance. Please try again soon.";
const FOOTPRINT_AIRDROP_IP_WINDOW_MS = parsePositiveIntegerEnv(
  "FOOTPRINT_AIRDROP_IP_WINDOW_MS",
  10 * 60 * 1000
);
const FOOTPRINT_AIRDROP_IP_LIMIT = parsePositiveIntegerEnv(
  "FOOTPRINT_AIRDROP_IP_LIMIT",
  120
);
const FOOTPRINT_AIRDROP_ADDRESS_WINDOW_MS = parsePositiveIntegerEnv(
  "FOOTPRINT_AIRDROP_ADDRESS_WINDOW_MS",
  60 * 1000
);
const FOOTPRINT_AIRDROP_ADDRESS_LIMIT = parsePositiveIntegerEnv(
  "FOOTPRINT_AIRDROP_ADDRESS_LIMIT",
  12
);

function parsePositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isMaintenanceModeEnabled() {
  return process.env.MAINTENANCE_MODE === "1";
}

function maintenanceUnavailable(c: Context) {
  return c.json({ success: false, error: MAINTENANCE_ERROR_MESSAGE }, 503);
}

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

function rateLimited(c: Context, retryAfterMs: number) {
  c.header("Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1000)).toString());
  return c.json(
    {
      success: false,
      error: "Please wait a moment before checking another Footprint Drop wallet.",
    },
    429
  );
}

function consumeFootprintAirdropLimits(c: Context, address: string) {
  const ipLimit = runtimeCache.consumeRateLimit(
    `footprint-airdrop:ip:${getRequestIp(c)}`,
    FOOTPRINT_AIRDROP_IP_LIMIT,
    FOOTPRINT_AIRDROP_IP_WINDOW_MS
  );

  if (!ipLimit.allowed) {
    return ipLimit;
  }

  return runtimeCache.consumeRateLimit(
    `footprint-airdrop:address:${address.trim().toLowerCase()}`,
    FOOTPRINT_AIRDROP_ADDRESS_LIMIT,
    FOOTPRINT_AIRDROP_ADDRESS_WINDOW_MS
  );
}

// GET /api/points/leaderboards
pointsRoutes.get("/leaderboards", async (c) => {
  if (isMaintenanceModeEnabled()) {
    return maintenanceUnavailable(c);
  }

  const rawType = c.req.query("type") ?? "particle_points";
  const type =
    rawType === "referral" || rawType === "volume" || rawType === "particle_points"
      ? rawType
      : "particle_points";
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(c.req.query("pageSize") ?? c.req.query("limit") ?? "10", 10))
  );
  const viewer = c.req.query("viewer") ?? undefined;

  try {
    const data = await pointsEngine.getLeaderboardHub(type, {
      page,
      pageSize,
      viewerAddress: viewer,
    });
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// POST /api/points/profile-cache
pointsRoutes.post("/profile-cache", async (c) => {
  const body = await c.req.json<{
    address?: string;
    fid?: string;
    username?: string | null;
    displayName?: string | null;
    pfpUrl?: string | null;
  }>();

  if (!body.address || !body.fid) {
    return c.json({ error: "address and fid required" }, 400);
  }

  try {
    await pointsEngine.cacheFarcasterProfile(body.address, {
      fid: body.fid,
      username: body.username,
      displayName: body.displayName,
      pfpUrl: body.pfpUrl,
    });
    return c.json({ success: true });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// POST /api/points/airdrop/lookup
pointsRoutes.post("/airdrop/lookup", async (c) => {
  if (isMaintenanceModeEnabled()) {
    return maintenanceUnavailable(c);
  }

  const body = await c.req.json<{ address?: string }>();

  if (!body.address) {
    return c.json({ success: false, error: "address required" }, 400);
  }

  const rateLimit = consumeFootprintAirdropLimits(c, body.address);
  if (!rateLimit.allowed) {
    return rateLimited(c, rateLimit.retryAfterMs);
  }

  try {
    const data = await pointsEngine.getFootprintAirdropStatus(body.address);
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    const message = (e as Error).message;
    if (message.toLowerCase().includes("blockscout")) {
      return c.json(
        {
          success: false,
          error: "Footprint Drop lookup is temporarily unavailable. Please try again shortly.",
        },
        503
      );
    }

    return c.json({ success: false, error: message }, 500);
  }
});

// POST /api/points/airdrop/claim
pointsRoutes.post("/airdrop/claim", async (c) => {
  if (isMaintenanceModeEnabled()) {
    return maintenanceUnavailable(c);
  }

  const body = await c.req.json<{
    address?: string;
    asset?: "eth" | "usdc";
    txHash?: string;
  }>();

  if (!body.address) {
    return c.json({ success: false, error: "address required" }, 400);
  }

  if (!body.txHash) {
    return c.json(
      {
        success: false,
        error: "txHash required for onchain Footprint Drop claim verification",
      },
      400
    );
  }

  const rateLimit = consumeFootprintAirdropLimits(c, body.address);
  if (!rateLimit.allowed) {
    return rateLimited(c, rateLimit.retryAfterMs);
  }

  try {
    const data = await pointsEngine.claimFootprintAirdrop(
      body.address,
      body.txHash,
      body.asset
    );
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
});

// POST /api/points/spin
pointsRoutes.post("/spin", async (c) => {
  const body = await c.req.json<{
    address?: string;
    txHash?: string;
  }>();

  if (!body.address || !body.txHash) {
    return c.json({ error: "address and txHash required" }, 400);
  }

  try {
    const result = await pointsEngine.spin(body.address, body.txHash);
    return c.json({ success: true, ...result });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
});

// GET /api/points/:address/summary
pointsRoutes.get("/:address/summary", async (c) => {
  if (isMaintenanceModeEnabled()) {
    return maintenanceUnavailable(c);
  }

  try {
    const data = await pointsEngine.getPointsSummary(c.req.param("address"));
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// GET /api/points/:address/spin-history
pointsRoutes.get("/:address/spin-history", async (c) => {
  try {
    const data = await pointsEngine.getSpinHistory(c.req.param("address"));
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// GET /api/points/:address
pointsRoutes.get("/:address", async (c) => {
  try {
    const data = await pointsEngine.getBalance(c.req.param("address"));
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// GET /api/points/:address/stats
pointsRoutes.get("/:address/stats", async (c) => {
  try {
    const data = await pointsEngine.getUserStats(c.req.param("address"));
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// GET /api/points/:address/referrals
pointsRoutes.get("/:address/referrals", async (c) => {
  try {
    const data = await pointsEngine.getReferralStats(c.req.param("address"));
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// POST /api/points/check-in
pointsRoutes.post("/check-in", async (c) => {
  const body = await c.req.json<{
    address?: string;
    txHash?: string;
    asset?: "eth" | "usdc";
  }>();
  if (!body.address || !body.txHash) {
    return c.json({ error: "address and txHash required" }, 400);
  }
  try {
    const result = await pointsEngine.dailyCheckIn(
      body.address,
      body.txHash,
      body.asset
    );
    return c.json({ success: true, ...result });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return c.json(
      { success: false, error: msg },
      msg === "Already checked in today" ? 400 : 500
    );
  }
});

// POST /api/points/check-in/reset
pointsRoutes.post("/check-in/reset", async (c) => {
  const body = await c.req.json<{ address?: string }>();
  if (!body.address) {
    return c.json({ error: "address required" }, 400);
  }

  try {
    const result = await pointsEngine.resetBrokenStreak(body.address);
    return c.json({ success: true, ...result });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
});

// POST /api/points/check-in/save
pointsRoutes.post("/check-in/save", async (c) => {
  const body = await c.req.json<{
    address?: string;
    txHash?: string;
    asset?: "eth" | "usdc";
  }>();

  if (!body.address || !body.txHash) {
    return c.json({ error: "address and txHash required" }, 400);
  }

  try {
    const result = await pointsEngine.recoverBrokenStreak(
      body.address,
      body.txHash,
      body.asset
    );
    return c.json({ success: true, ...result });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
});

// POST /api/points/record-sweep
pointsRoutes.post("/record-sweep", async (c) => {
  const body = await c.req.json<{
    address?: string;
    txHash?: string;
    tokenCount?: number;
    volumeUsd?: number;
  }>();
  if (!body.address || !body.txHash || body.tokenCount == null) {
    return c.json({ error: "Missing fields" }, 400);
  }
  try {
    const pts = await pointsEngine.recordSweep(
      body.address,
      body.txHash,
      body.tokenCount,
      body.volumeUsd ?? 0
    );
    return c.json({ success: true, pointsAwarded: pts });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// POST /api/points/record-bridge
pointsRoutes.post("/record-bridge", async (c) => {
  const body = await c.req.json<{
    address?: string;
    txHash?: string;
    tokenCount?: number;
    sourceChain?: number;
    volumeUsd?: number;
  }>();
  if (!body.address || !body.txHash) {
    return c.json({ error: "Missing fields" }, 400);
  }
  try {
    const pts = await pointsEngine.recordBridge(
      body.address,
      body.txHash,
      body.tokenCount ?? 1,
      body.sourceChain ?? 0,
      body.volumeUsd ?? 0
    );
    return c.json({ success: true, pointsAwarded: pts });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// POST /api/points/record-burn
pointsRoutes.post("/record-burn", async (c) => {
  const body = await c.req.json<{
    address?: string;
    txHash?: string;
    tokenCount?: number;
  }>();
  if (!body.address || !body.txHash) {
    return c.json({ error: "Missing fields" }, 400);
  }
  try {
    const pts = await pointsEngine.recordBurn(
      body.address,
      body.txHash,
      body.tokenCount ?? 1
    );
    return c.json({ success: true, pointsAwarded: pts });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// POST /api/points/record-swap
pointsRoutes.post("/record-swap", async (c) => {
  const body = await c.req.json<{
    address?: string;
    txHash?: string | null;
    orderId?: string | null;
    inputToken?: string | null;
    outputToken?: string | null;
    amountIn?: string | null;
    amountOut?: string | null;
    volumeUsd?: number | null;
  }>();
  if (!body.address || (!body.txHash && !body.orderId)) {
    return c.json({ error: "address and txHash or orderId required" }, 400);
  }
  try {
    const pts = await pointsEngine.recordSwap(body.address, {
      txHash: body.txHash,
      orderId: body.orderId,
      inputToken: body.inputToken,
      outputToken: body.outputToken,
      amountIn: body.amountIn,
      amountOut: body.amountOut,
      volumeUsd: body.volumeUsd,
    });
    return c.json({ success: true, pointsAwarded: pts });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// GET /api/points/leaderboard
pointsRoutes.get("/leaderboard", async (c) => {
  const page  = Math.max(1,   parseInt(c.req.query("page")  ?? "1", 10));
  const limit = Math.min(100, parseInt(c.req.query("limit") ?? "50", 10));
  try {
    const data = await pointsEngine.getLeaderboard(page, limit);
    return c.json({ success: true, page, limit, data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// POST /api/points/referral/apply
pointsRoutes.post("/referral/apply", async (c) => {
  if (isMaintenanceModeEnabled()) {
    return maintenanceUnavailable(c);
  }

  const body = await c.req.json<{ address?: string; referralCode?: string }>();
  const address = body.address?.trim();
  const referralCode = body.referralCode?.trim();

  if (!address || !referralCode) {
    return c.json({ success: false, error: "address and referralCode required" }, 400);
  }

  const referralApplyRateLimit = runtimeCache.consumeRateLimit(
    `points:referral-apply:${address.toLowerCase()}`,
    4,
    10_000
  );

  if (!referralApplyRateLimit.allowed) {
    return c.json(
      {
        success: false,
        error: "Referral apply is cooling down. Please wait a few seconds.",
      },
      429
    );
  }

  try {
    const result = await pointsEngine.applyReferral(address, referralCode);

    if (!result.applied) {
      const status = result.deferred ? 202 : 400;
      return c.json(
        {
          success: false,
          deferred: result.deferred === true,
          message: result.message,
          error: result.message,
          idempotent: result.idempotent === true,
        },
        status
      );
    }

    return c.json({
      success: true,
      message: result.message,
      idempotent: result.idempotent === true,
    });
  } catch (e: unknown) {
    const message = (e as Error).message;
    const status = message === "Referral application already in progress" ? 409 : 400;

    return c.json({ success: false, error: message }, status);
  }
});

// POST /api/points/referral/preview (read-only validation — no DB writes)
pointsRoutes.post("/referral/preview", async (c) => {
  const body = await c.req.json<{ address?: string; referralCode?: string }>();
  if (!body.address || !body.referralCode) {
    return c.json({ success: false, valid: false, message: "address and referralCode required" }, 400);
  }
  try {
    const result = await pointsEngine.previewReferral(body.address, body.referralCode);
    return c.json({ success: true, ...result });
  } catch (e: unknown) {
    return c.json({ success: false, valid: false, message: (e as Error).message }, 500);
  }
});

export { pointsRoutes };
