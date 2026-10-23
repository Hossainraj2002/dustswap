import { Hono, type Context } from "hono";
import {
  PartnerProgramError,
  partnerProgramService,
} from "../services/partnerProgram";
import { isMaintenanceBlocking, maintenanceUnavailable } from "../utils/maintenance";
import { getAuthAddress, isSameAddress } from "../middleware/requireWalletAuth";

const partnerRoutes = new Hono();

/**
 * Require a verified session that owns `address`. Returns the validated address,
 * or a Response to short-circuit with (401/403). Partner data exposes earnings
 * and fee-share metrics, so it must not be readable for arbitrary addresses.
 */
function requireOwnedAddress(
  c: Context,
  address: string | undefined
): { ok: true; address: string } | { ok: false; response: Response } {
  if (!address) {
    return { ok: false, response: c.json({ success: false, error: "address is required" }, 400) };
  }

  const authAddress = getAuthAddress(c);
  if (!authAddress) {
    return { ok: false, response: c.json({ success: false, error: "Authentication required." }, 401) };
  }
  if (!isSameAddress(authAddress, address)) {
    return { ok: false, response: c.json({ success: false, error: "Forbidden." }, 403) };
  }

  return { ok: true, address };
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

function getAdminToken() {
  const token = process.env.PARTNER_ADMIN_TOKEN || process.env.QUEST_ADMIN_TOKEN;
  if (!token) {
    throw new Error("PARTNER_ADMIN_TOKEN is not configured");
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
  if (error instanceof PartnerProgramError) {
    return {
      status: error.status,
      body: {
        success: false,
        error: error.message,
      },
    } as const;
  }

  return {
    status: 500,
    body: {
      success: false,
      error: (error as Error).message || "Partner program request failed",
    },
  } as const;
}

partnerRoutes.get("/dashboard", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const guard = requireOwnedAddress(c, c.req.query("address"));
    if (!guard.ok) {
      return guard.response;
    }

    const data = await partnerProgramService.getDashboard(guard.address);
    return c.json({ success: true, ...data });
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.get("/history", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const guard = requireOwnedAddress(c, c.req.query("address"));
    if (!guard.ok) {
      return guard.response;
    }

    const data = await partnerProgramService.getHistory(guard.address);
    return c.json({ success: true, ...data });
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.get("/submissions", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const guard = requireOwnedAddress(c, c.req.query("address"));
    if (!guard.ok) {
      return guard.response;
    }

    const data = await partnerProgramService.getSubmissions(guard.address);
    return c.json({ success: true, ...data });
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.post("/join", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const body = await c.req.json<{
      address?: string;
      message?: string;
      signature?: `0x${string}`;
    }>();

    const data = await partnerProgramService.joinProgram(body, getRequestIp(c));
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.post("/submissions", async (c) => {
  if (await isMaintenanceBlocking(c)) {
    return maintenanceUnavailable(c);
  }

  try {
    const body = await c.req.json<{
      address?: string;
      message?: string;
      signature?: `0x${string}`;
      url?: string;
    }>();

    const data = await partnerProgramService.submitContent(body, getRequestIp(c));
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.get("/admin/leaderboard", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const search = c.req.query("search") || undefined;
    const data = await partnerProgramService.getAdminLeaderboard(search);
    return c.json({ success: true, ...data });
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.post("/admin/members", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const body = await c.req.json<{
      address?: string;
      feeSharePercent?: number;
      isAdmin?: boolean;
    }>();
    const data = await partnerProgramService.upsertMember(body);
    return c.json({ success: true, ...data });
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.post("/admin/members/batch", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const body = await c.req.json<{
      addresses?: string[];
      feeSharePercent?: number;
      isAdmin?: boolean;
    }>();
    const data = await partnerProgramService.upsertMembersBulk(body);
    return c.json({ success: true, ...data });
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.post("/admin/members/remove-pending", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const body = await c.req.json<{
      addresses?: string[];
    }>();
    const data = await partnerProgramService.removePendingMembers(body);
    return c.json({ success: true, ...data });
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.get("/admin/members/:address", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const data = await partnerProgramService.getAdminMemberDetail(c.req.param("address"));
    return c.json({ success: true, ...data });
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.post("/admin/distributions/mark-paid", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const body = await c.req.json<{
      address?: string;
      weekStartUtc?: string;
      payoutUsdcAmount?: number;
      payoutTxHash?: string;
      paidNotes?: string | null;
    }>();
    const data = await partnerProgramService.markDistributionPaid(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

partnerRoutes.post("/admin/distributions/settle", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const body = await c.req.json<{
      address?: string;
      weekStartUtc?: string;
      payoutTxHash?: string;
      paidNotes?: string | null;
    }>();
    const data = await partnerProgramService.settleDistributionPayout(body);
    return c.json(data);
  } catch (error) {
    const payload = getErrorPayload(error);
    return c.json(payload.body, payload.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
});

export { partnerRoutes };
