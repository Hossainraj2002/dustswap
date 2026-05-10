import dotenv from "dotenv";
dotenv.config();

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { authRoutes } from "./routes/auth";
import { partnerRoutes } from "./routes/partner";
import { pointsRoutes } from "./routes/points";
import { profileSettingsRoutes } from "./routes/profileSettings";
import { questsRoutes } from "./routes/quests";
import { swapsRoutes } from "./routes/swaps";
import { dustsweepRoutes } from "./routes/dustsweep";
import { pointsEngine } from "./services/pointsEngine";
import tokens from "./routes/tokens";
import { getAllowedAppOrigins, isAllowedAppOrigin } from "./config/appOrigins";
import { getDatabaseDiagnostics } from "./services/postgres";
import { testDbConnection } from "./lib/db";

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

app.route("/api/tokens", tokens);
app.route("/api/auth", authRoutes);
app.route("/api/partner", partnerRoutes);
app.route("/api/points", pointsRoutes);
app.route("/api/profile-settings", profileSettingsRoutes);
app.route("/api/quests", questsRoutes);
app.route("/api/swaps", swapsRoutes);
app.route("/api/dustsweep", dustsweepRoutes);

pointsEngine.startReferralLeaderboardSnapshotScheduler();

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
      "POST /api/partner/join": "Verify partner join signature and unlock dashboard access",
      "GET /api/profile-settings?address=": "Get merged profile settings",
      "POST /api/profile-settings": "Save signed profile settings",
      "POST /api/profile-settings/pfp-upload-url": "Create signed R2 PFP upload URL",
      "POST /api/points/airdrop/lookup": "Preview Footprint Drop eligibility",
      "POST /api/points/airdrop/claim": "Claim Footprint Drop PP",
      "POST /api/points/check-in": "Daily check-in",
      "POST /api/points/record-sweep": "Record sweep for points",
      "GET /api/quests": "Get active quests and user progress",
      "GET /api/quests/discord/connect": "Start signed Discord OAuth connection",
      "GET /api/quests/discord/callback": "Discord OAuth callback",
      "POST /api/quests/discord/verify": "Verify Discord server membership",
      "POST /api/quests/activities/swap": "Record swap activity for quest progress",
      "POST /api/swaps/record": "Capture and decode an OpenOcean swap transaction",
      "GET /api/dustsweep/tokens/:address": "Get sweepable wallet tokens",
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
