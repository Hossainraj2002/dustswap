import { Hono } from "hono";
import { getAdminMonitor } from "../services/monitoring";

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

export { monitorRoutes };
