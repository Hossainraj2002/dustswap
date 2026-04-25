import dotenv from "dotenv";
dotenv.config();

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { authRoutes } from "./routes/auth";
import { pointsRoutes } from "./routes/points";
import { profileSettingsRoutes } from "./routes/profileSettings";
import { questsRoutes } from "./routes/quests";
import { swapsRoutes } from "./routes/swaps";
import tokens from "./routes/tokens";
import { getSupabaseDiagnostics } from "./services/supabase";

const app = new Hono();
const allowedOrigins = Array.from(
  new Set(
    [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://dustswap.xyz",
      "https://www.dustswap.xyz",
      "https://app.dustswap.wtf",
      "https://dustswap.vercel.app",
      "https://dustswap-web.vercel.app",
      process.env.NEXT_PUBLIC_APP_URL,
    ].filter((value): value is string => Boolean(value))
  )
);

app.use("*", logger());
app.use("*", prettyJSON());
app.use(
  "*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-admin-token"],
    maxAge: 86400,
  })
);

app.route("/api/tokens", tokens);
app.route("/api/auth", authRoutes);
app.route("/api/points", pointsRoutes);
app.route("/api/profile-settings", profileSettingsRoutes);
app.route("/api/quests", questsRoutes);
app.route("/api/swaps", swapsRoutes);

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
      "GET /api/profile-settings?address=": "Get merged profile settings",
      "POST /api/profile-settings": "Save signed profile settings",
      "POST /api/profile-settings/pfp-upload-url": "Create signed R2 PFP upload URL",
      "POST /api/points/airdrop/lookup": "Preview Footprint Drop eligibility",
      "POST /api/points/airdrop/claim": "Claim Footprint Drop PP",
      "POST /api/points/check-in": "Daily check-in",
      "POST /api/points/record-sweep": "Record sweep for points",
      "GET /api/quests": "Get active quests and user progress",
      "POST /api/quests/activities/swap": "Record swap activity for quest progress",
      "POST /api/swaps/record": "Capture and decode an OpenOcean swap transaction",
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
  const supabase = getSupabaseDiagnostics();
  console.log(
    `[DustSwap API] SUPABASE: urlRef=${supabase.urlRef}, keyEnv=${supabase.loadedEnv}, keyType=${supabase.keyType}`
  );
});

export default app;
