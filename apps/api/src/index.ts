// apps/api/src/index.ts

import dotenv from "dotenv";
dotenv.config();

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { serve } from "@hono/node-server";
import tokens from "./routes/tokens";
// ✅ Fixed: import and register points routes
import { pointsRoutes } from "./routes/points";

const app = new Hono();

// ─── Middleware ─────────────────────────────────────────────────────────────────

app.use("*", logger());
app.use("*", prettyJSON());
app.use(
  "*",
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://dustswap.xyz",
      "https://www.dustswap.xyz",
      "https://dustswap.vercel.app",
      "https://dustswap-web.vercel.app",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// ─── Routes ────────────────────────────────────────────────────────────────────

app.route("/api/tokens", tokens);
// ✅ Fixed: mount points routes
app.route("/api/points", pointsRoutes);

// Root health check
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
      "POST /api/points/check-in": "Daily check-in",
      "POST /api/points/record-sweep": "Record sweep for points",
    },
  });
});

// 404 handler
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

// Error handler
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

// ─── Start server ──────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? "3001", 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`[DustSwap API] Listening on port ${port}`);
});

export default app;