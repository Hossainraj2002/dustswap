import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

const databaseUrl = process.env.DATABASE_URL || "";
if (
  process.env.NODE_ENV !== "production" &&
  process.env.DATABASE_PUBLIC_URL &&
  /\.railway\.internal(?::|\/|$)/i.test(databaseUrl)
) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { bodyLimit } from "hono/body-limit";
import { getClientIp } from "./utils/clientIp";
import { authRoutes } from "./routes/auth";
import { partnerRoutes } from "./routes/partner";
import { pointsRoutes } from "./routes/points";
import { profileCompletionRoutes } from "./routes/profileCompletion";
import { profileSettingsRoutes } from "./routes/profileSettings";
import { questsRoutes } from "./routes/quests";
import { monitorRoutes } from "./routes/monitor";
import { notificationsRoutes } from "./routes/notifications";
import { swapsRoutes } from "./routes/swaps";
import { swapownRoutes } from "./routes/swapown";
import { dustsweepRoutes } from "./routes/dustsweep";
import { sweepCampaignRoutes } from "./routes/sweepCampaign";
import { walletLinkRoutes } from "./routes/walletLink";
import { pointsEngine } from "./services/pointsEngine";
import { sweepCampaignService } from "./services/sweepCampaign";
import { repostQuestRewardScheduler } from "./services/repostQuestRewards";
import { notificationScheduler } from "./services/notificationScheduler";
import tokens from "./routes/tokens";
import { getAllowedAppOrigins, isAllowedAppOrigin } from "./config/appOrigins";
import { getDatabaseDiagnostics } from "./services/postgres";
import { testDbConnection } from "./lib/db";
import { runtimeCache } from "./utils/runtimeCache";

const app = new Hono();
const allowedOrigins = getAllowedAppOrigins();

app.use("*", logger());
app.use("*", prettyJSON());
app.use(
  "*",
  cors({
    origin: (origin) => isAllowedAppOrigin(origin),
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-admin-token",
      "X-Dustswap-Maintenance-Bypass",
    ],
    maxAge: 86400,
  })
);

// Global request body cap so a single huge POST can't exhaust memory (OOM).
// Generous — real bodies (even a 50-token sweep quote) are tens of KB, so this
// is ~150x headroom and never affects legitimate requests. Tunable via env.
const MAX_BODY_BYTES = (() => {
  const parsed = Number.parseInt(process.env.API_MAX_BODY_BYTES || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 1024 * 1024;
})();
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ success: false, error: "Request body too large." }, 413),
  })
);

// Per-IP read throttle to stop bulk enumeration/scraping of address-keyed data.
// GET-only so signed writes and server-to-server POSTs (e.g. profile-cache) are
// unaffected. Generous for normal browsing; tunable via env.
const API_READ_RATE_LIMIT = (() => {
  const parsed = Number.parseInt(process.env.API_READ_RATE_LIMIT || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1200;
})();
const API_READ_RATE_WINDOW_MS = (() => {
  const parsed = Number.parseInt(process.env.API_READ_RATE_WINDOW_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

// Scope the throttle to address-keyed READ endpoints (the enumeration targets).
// Deliberately excludes server-proxied routes like /api/dustsweep (whose calls
// share the Next server's IP) and unrelated routes, so normal app traffic and
// sweeping are never throttled.
const RATE_LIMITED_READ_PREFIXES = [
  "/api/points/",
  "/api/profile-settings",
  "/api/profile-completion",
  "/api/partner/",
  "/api/wallet-link/",
  "/api/dustsweep/campaign/",
];

app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET") {
    return next();
  }

  const path = c.req.path;
  if (!RATE_LIMITED_READ_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return next();
  }

  const limit = runtimeCache.consumeRateLimit(
    `api:read:ip:${getClientIp(c)}`,
    API_READ_RATE_LIMIT,
    API_READ_RATE_WINDOW_MS
  );

  if (!limit.allowed) {
    c.header("Retry-After", Math.max(1, Math.ceil(limit.retryAfterMs / 1000)).toString());
    return c.json({ success: false, error: "Too many requests. Please slow down." }, 429);
  }

  return next();
});

app.route("/api/tokens", tokens);
app.route("/api/auth", authRoutes);
app.route("/api/partner", partnerRoutes);
app.route("/api/points", pointsRoutes);
app.route("/api/profile-completion", profileCompletionRoutes);
app.route("/api/profile-settings", profileSettingsRoutes);
app.route("/api/quests", questsRoutes);
app.route("/api/monitor", monitorRoutes);
app.route("/api/swaps", swapsRoutes);
app.route("/api/swapown", swapownRoutes);
// Mounted before /api/dustsweep so the sub-path always resolves here.
app.route("/api/dustsweep/campaign", sweepCampaignRoutes);
app.route("/api/dustsweep", dustsweepRoutes);
app.route("/api/wallet-link", walletLinkRoutes);
app.route("/api/notifications", notificationsRoutes);

pointsEngine.startReferralLeaderboardSnapshotScheduler();
repostQuestRewardScheduler.start();
sweepCampaignService.startSweepCampaignSchedulers();
notificationScheduler.start();
runtimeCache.startEvictionLoop();

app.get("/health/db", async (c) => {
  const startedAt = Date.now();
  try {
    await testDbConnection();
    return c.json({
      status: "ok",
      latency_ms: Date.now() - startedAt,
    });
  } catch (error) {
    return c.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Database check failed",
      },
      500
    );
  }
});

app.get("/", (c) => {
  return c.json({
    name: "DustSwap API",
    version: "1.0.0",
    chain: "base",
    chainId: 8453,
    endpoints: {
      "GET /api/tokens/balances?address=": "Get all ERC-20 balances",
      "GET /api/tokens/prices?tokens=": "Get USD prices for tokens",
      "GET /api/tokens/dust?address=&threshold=": "Analyze dust tokens",
      "GET /api/tokens/quote?tokenIn=&tokenOut=&amountIn=": "Get swap quote",
      "POST /api/tokens/batch-quote": "Get batch swap quotes",
      "GET /api/tokens/health": "Service health check",
      "GET /api/points/:address": "Get points balance",
      "GET /api/partner/dashboard?address=": "Get partner dashboard state and metrics",
      "GET /api/partner/history?address=": "Get partner distribution history",
      "GET /api/partner/submissions?address=": "Get partner content submission history",
      "POST /api/partner/join": "Verify partner join signature and unlock dashboard access",
      "POST /api/partner/submissions": "Create a signed partner content submission",
      "POST /api/partner/admin/members": "Whitelist or update one partner member",
      "POST /api/partner/admin/members/batch": "Whitelist or update many partner members at once",
      "POST /api/partner/admin/members/remove-pending": "Remove pending whitelisted partner members",
      "POST /api/partner/admin/distributions/settle": "Verify an on-chain USDC payout and mark the closed week paid",
      "GET /api/profile-completion?address=": "Get profile completion guide state",
      "POST /api/profile-completion/impression": "Record profile completion guide impressions",
      "POST /api/profile-completion/dismiss": "Dismiss the profile completion guide",
      "POST /api/profile-completion/claim": "Claim the profile completion PP bonus",
      "GET /api/profile-settings?address=": "Get merged profile settings",
      "POST /api/profile-settings": "Save signed profile settings",
      "POST /api/profile-settings/pfp-upload-url": "Create signed R2 PFP upload URL",
      "POST /api/points/airdrop/lookup": "Preview Footprint Drop eligibility",
      "POST /api/points/airdrop/claim": "Claim Footprint Drop PP",
      "POST /api/points/check-in": "Daily check-in",
      "POST /api/points/record-sweep": "Record sweep for points",
      "GET /api/quests": "Get active quests and user progress",
      "GET /api/monitor/admin?window=utc-day": "Admin: live monitoring dashboard data",
      "GET /api/quests/discord/connect": "Start signed Discord OAuth connection",
      "GET /api/quests/discord/callback": "Discord OAuth callback",
      "POST /api/quests/discord/verify": "Verify Discord server membership",
      "POST /api/quests/activities/swap": "Record swap activity for quest progress",
      "POST /api/swaps/record": "Capture and decode an OpenOcean swap transaction",
      "GET /api/swapown/sources": "Get DustSwap direct-DEX source readiness",
      "POST /api/swapown/quote": "Build a DustSwap direct-DEX aggregator quote",
      "POST /api/swapown/build-tx": "Build DustSwap aggregator router calldata",
      "GET /api/dustsweep/tokens?address=0x...&chainId=8453": "Discover wallet tokens",
      "GET /api/dustsweep/tokens/:address": "Get sweepable wallet tokens (legacy path)",
      "POST /api/dustsweep/quote": "Build a DustSweep quote",
      "POST /api/dustsweep/build-tx": "Build DustSweep Permit2 typed data and calldata",
      "POST /api/dustsweep/record-sweep": "Record a completed DustSweep",
      "POST /api/dustsweep/admin/sync-whitelist": "Admin: sync liquid Base token whitelist",
      "POST /api/dustsweep/admin/sync-whitelist-onchain": "Admin: sync whitelist from onchain Base DEX pools",
    },
  });
});

app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: "Not Found",
      data: null,
    },
    404
  );
});

app.onError((err, c) => {
  console.error("[Unhandled Error]", err);
  return c.json(
    {
      success: false,
      error: "Internal Server Error",
      data: null,
    },
    500
  );
});

const port = parseInt(process.env.PORT ?? "3001", 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`[DustSwap API] Listening on port ${port}`);
  const apiKey =
    process.env.ONCHAINKIT_API_KEY || process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY || "";
  console.log(
    `[DustSwap API] ONCHAINKIT_API_KEY: ${apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)} (loaded)` : "NOT SET"}`
  );
  const db = getDatabaseDiagnostics();
  console.log(
    `[DustSwap API] DB: urlRef=${db.urlRef}, env=${db.loadedEnv}, driver=${db.keyType}`
  );
  console.log(`[DustSwap API] APP_ORIGINS: ${allowedOrigins.join(", ")}`);
  testDbConnection()
    .then((latencyMs) => {
      console.log(`[DustSwap API] DB connected successfully (${latencyMs}ms)`);
    })
    .catch((error) => {
      console.error(
        `[DustSwap API] DB connection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
});

export default app;
