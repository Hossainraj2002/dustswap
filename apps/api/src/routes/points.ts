// apps/api/src/routes/points.ts
// ✅ Fixed: rewritten from Express to Hono (matches the rest of the API)

import { Hono } from "hono";
import { pointsEngine } from "../services/pointsEngine";

const pointsRoutes = new Hono();

// GET /api/points/:address
pointsRoutes.get("/:address", async (c) => {
  try {
    const data = await pointsEngine.getBalance(c.req.param("address"));
    return c.json({ success: true, ...data });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
});

// POST /api/points/check-in
pointsRoutes.post("/check-in", async (c) => {
  const body = await c.req.json<{ address?: string }>();
  if (!body.address) {
    return c.json({ error: "address required" }, 400);
  }
  try {
    const result = await pointsEngine.dailyCheckIn(body.address);
    return c.json({ success: true, ...result });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return c.json(
      { success: false, error: msg },
      msg === "Already checked in today" ? 400 : 500
    );
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
  const body = await c.req.json<{ address?: string; txHash?: string }>();
  if (!body.address || !body.txHash) {
    return c.json({ error: "Missing fields" }, 400);
  }
  try {
    const pts = await pointsEngine.recordSwap(body.address, body.txHash);
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
  const body = await c.req.json<{ address?: string; referralCode?: string }>();
  if (!body.address || !body.referralCode) {
    return c.json({ error: "address and referralCode required" }, 400);
  }
  try {
    await pointsEngine.applyReferral(body.address, body.referralCode);
    return c.json({ success: true, message: "Referral applied!" });
  } catch (e: unknown) {
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
});

export { pointsRoutes };