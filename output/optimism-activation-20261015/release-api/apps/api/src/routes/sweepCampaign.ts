import { Hono, type Context } from "hono";
import {
  SweepCampaignError,
  sweepCampaignService,
} from "../services/sweepCampaign";

const sweepCampaignRoutes = new Hono();

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
    c.req.header("x-client-ip") ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function getAdminToken() {
  const token =
    process.env.SWEEP_CAMPAIGN_ADMIN_TOKEN ||
    process.env.QUEST_ADMIN_TOKEN ||
    process.env.PARTNER_ADMIN_TOKEN;
  if (!token) {
    throw new Error("SWEEP_CAMPAIGN_ADMIN_TOKEN is not configured");
  }

  return token;
}

function assertAdmin(c: Context) {
  const expected = getAdminToken();
  const received = c.req.header("x-admin-token");
  if (!received || received !== expected) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  return null;
}

function getErrorPayload(error: unknown) {
  if (error instanceof SweepCampaignError) {
    return {
      status: error.status,
      body: { success: false, error: error.message },
    } as const;
  }

  return {
    status: 500,
    body: {
      success: false,
      error: (error as Error).message || "Sweep campaign request failed",
    },
  } as const;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

sweepCampaignRoutes.get("/status", async (c) => {
  try {
    const data = await sweepCampaignService.getStatusForAddress(c.req.query("address"));
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.get("/leaderboard", async (c) => {
  try {
    const data = await sweepCampaignService.getLeaderboard({
      page: Number(c.req.query("page") || 1),
      pageSize: Number(c.req.query("pageSize") || 50),
      viewerAddress: c.req.query("viewer") || null,
    });
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.post("/claim", async (c) => {
  try {
    const body = await c.req.json<{
      address?: string;
      tier?: number;
      message?: string;
      signature?: string;
    }>();

    const data = await sweepCampaignService.claimTier({
      address: body.address,
      tier: body.tier,
      message: body.message,
      signature: body.signature,
      requestIp: getRequestIp(c),
    });
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.post("/claim-prize", async (c) => {
  try {
    const body = await c.req.json<{
      address?: string;
      message?: string;
      signature?: string;
    }>();

    const data = await sweepCampaignService.claimPrize({
      address: body.address,
      message: body.message,
      signature: body.signature,
      requestIp: getRequestIp(c),
    });
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});
// ── Admin ───────────────────────────────────────────────────────────────────

sweepCampaignRoutes.get("/admin/claims", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const data = await sweepCampaignService.listClaims({
      status: c.req.query("status") || null,
    });
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.get("/admin/credits", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const data = await sweepCampaignService.listCredits({
      status: c.req.query("status") || null,
      flagged: c.req.query("flagged") === "true",
    });
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.post("/admin/credits/requeue", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const body = await c.req.json<{ creditId?: number }>();
    const data = await sweepCampaignService.requeueCredit(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.post("/admin/claims/approve", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const body = await c.req.json<{ claimIds?: number[] }>();
    const data = await sweepCampaignService.approveClaims(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.post("/admin/claims/settle", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const body = await c.req.json<{
      claimIds?: number[];
      payoutTxHash?: string;
      paidNotes?: string | null;
    }>();
    const data = await sweepCampaignService.settleClaimsManually(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.post("/admin/finalize", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const body = await c.req.json<{ force?: boolean }>().catch(() => ({}));
    const data = await sweepCampaignService.finalizeCampaign(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

sweepCampaignRoutes.get("/admin/payouts", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  return c.json({ success: true, payout: sweepCampaignService.getPayoutState() });
});

sweepCampaignRoutes.post("/admin/payouts/pause", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  sweepCampaignService.pausePayouts("paused by admin");
  return c.json({ success: true, payout: sweepCampaignService.getPayoutState() });
});

sweepCampaignRoutes.post("/admin/payouts/resume", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  sweepCampaignService.resumePayouts();
  void sweepCampaignService.processPayouts().catch(() => null);
  return c.json({ success: true, payout: sweepCampaignService.getPayoutState() });
});


sweepCampaignRoutes.post("/admin/prizes/open", async (c) => {
  const unauthorized = assertAdmin(c);
  if (unauthorized) return unauthorized;

  try {
    const body = await c.req.json<{ openAt?: string | null }>().catch(() => ({}));
    const data = await sweepCampaignService.openPrizeClaims(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as ErrorStatus);
  }
});

export { sweepCampaignRoutes };
