import { Hono } from "hono";
import { getAdminMonitor } from "../services/monitoring";
import { fetchUserStatus } from "../services/baseNotifications";
import { isCampaignKey } from "../services/notificationCampaigns";
import {
  getNotificationAdminSummary,
  runCampaign,
  syncNotificationAudience,
} from "../services/notificationScheduler";

const monitorRoutes = new Hono();

function getMonitorAdminToken() {
  const token =
    process.env.MONITOR_ADMIN_TOKEN ||
    process.env.QUEST_ADMIN_TOKEN ||
    process.env.PARTNER_ADMIN_TOKEN;

  if (!token) {
    throw new Error("MONITOR_ADMIN_TOKEN or QUEST_ADMIN_TOKEN is not configured");
  }

  return token;
}

function assertAdmin(c: any) {
  const expected = getMonitorAdminToken();
  const received = c.req.header("x-admin-token");

  if (!received || received !== expected) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  return null;
}

monitorRoutes.get("/admin", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const data = await getAdminMonitor(c.req.query("window"));
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json({ success: true, data });
  } catch (error) {
    return c.json(
      { success: false, error: (error as Error).message },
      500
    );
  }
});

// --- Base App notifications -------------------------------------------------

monitorRoutes.get("/admin/notifications", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const data = await getNotificationAdminSummary();
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

/** Pulls the opted-in wallet list from Base into notification_audience. */
monitorRoutes.post("/admin/notifications/sync", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const data = await syncNotificationAudience();
    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

/**
 * Fires one campaign out of schedule. Defaults to a dry run so a mistyped
 * campaign key cannot blast the audience; pass dryRun: false to send.
 */
monitorRoutes.post("/admin/notifications/run", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  const body = await c.req.json<{
    campaign?: string;
    dryRun?: boolean;
    force?: boolean;
    maxRecipients?: number;
  }>();

  const campaign = String(body.campaign || "").trim();

  if (!isCampaignKey(campaign)) {
    return c.json({ success: false, error: "Unknown campaign" }, 400);
  }

  try {
    const data = await runCampaign(campaign, {
      dryRun: body.dryRun !== false,
      force: body.force === true,
      maxRecipients:
        typeof body.maxRecipients === "number" ? body.maxRecipients : undefined,
      source: "admin",
    });

    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

/** Whether one wallet has pinned the app and enabled notifications. */
monitorRoutes.get("/admin/notifications/status/:address", async (c) => {
  const authError = assertAdmin(c);
  if (authError) {
    return authError;
  }

  try {
    const data = await fetchUserStatus(c.req.param("address"));
    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

export { monitorRoutes };
