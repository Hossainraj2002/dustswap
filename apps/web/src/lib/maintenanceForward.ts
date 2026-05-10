import {
  MAINTENANCE_BYPASS_COOKIE_NAME,
  MAINTENANCE_BYPASS_HEADER,
  verifyMaintenanceBypassToken,
} from "@/lib/maintenanceBypassToken";

function getCookieFromHeader(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const p = part.trim();
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const k = p.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(eq + 1).trim());
  }
  return undefined;
}

/** Forward verified maintenance cookie as API header (Next.js route handlers, proxy). */
export async function maintenanceBypassHeadersFromRequest(
  request: Request
): Promise<Record<string, string>> {
  const secret = process.env.MAINTENANCE_BYPASS_SECRET?.trim();
  if (!secret) return {};
  const token = getCookieFromHeader(
    request.headers.get("cookie"),
    MAINTENANCE_BYPASS_COOKIE_NAME
  );
  if (!token) return {};
  const v = await verifyMaintenanceBypassToken(token, secret);
  if (!v.ok) return {};
  return { [MAINTENANCE_BYPASS_HEADER]: token };
}

export async function maintenanceBypassHeadersFromCookieStore(cookieStore: {
  get(name: string): { value: string } | undefined;
}): Promise<Record<string, string>> {
  const secret = process.env.MAINTENANCE_BYPASS_SECRET?.trim();
  if (!secret) return {};
  const token = cookieStore.get(MAINTENANCE_BYPASS_COOKIE_NAME)?.value;
  if (!token) return {};
  const v = await verifyMaintenanceBypassToken(token, secret);
  if (!v.ok) return {};
  return { [MAINTENANCE_BYPASS_HEADER]: token };
}
