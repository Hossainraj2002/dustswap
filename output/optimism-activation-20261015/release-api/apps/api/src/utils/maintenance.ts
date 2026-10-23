import type { Context } from "hono";
import {
  MAINTENANCE_BYPASS_HEADER,
  maintenanceBypassConfigured,
  verifyMaintenanceBypassToken,
} from "./maintenanceBypassToken";

const MAINTENANCE_ERROR_MESSAGE =
  "DustSwap is under maintenance. Please try again soon.";

export function maintenanceUnavailable(c: Context) {
  return c.json({ success: false, error: MAINTENANCE_ERROR_MESSAGE }, 503);
}

/** True when the request should be blocked (503) due to maintenance. */
export async function isMaintenanceBlocking(c: Context): Promise<boolean> {
  if (process.env.MAINTENANCE_MODE !== "1") return false;
  const secret = process.env.MAINTENANCE_BYPASS_SECRET?.trim();
  if (!maintenanceBypassConfigured(secret)) return true;
  const header = c.req.header(MAINTENANCE_BYPASS_HEADER);
  const v = await verifyMaintenanceBypassToken(header, secret);
  return !v.ok;
}
