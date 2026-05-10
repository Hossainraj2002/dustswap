import { NextResponse } from "next/server";
import {
  createMaintenanceBypassToken,
  MAINTENANCE_BYPASS_COOKIE_NAME,
  maintenanceBypassConfigured,
  timingSafeEqualPassword,
} from "@/lib/maintenanceBypassToken";

const TOKEN_MAX_AGE_SEC = 8 * 60 * 60;

export async function POST(request: Request) {
  if (process.env.MAINTENANCE_MODE !== "1") {
    return NextResponse.json({ ok: false, error: "Unavailable" }, { status: 404 });
  }

  const secret = process.env.MAINTENANCE_BYPASS_SECRET?.trim();
  const expectedPassword = process.env.MAINTENANCE_BYPASS_PASSWORD;

  if (!maintenanceBypassConfigured(secret) || !expectedPassword?.trim()) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { password?: string };
  try {
    body = (await request.json()) as { password?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!(await timingSafeEqualPassword(password, expectedPassword))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const apiToken = await createMaintenanceBypassToken(secret!);
  const res = NextResponse.json({ ok: true, apiToken });
  res.cookies.set(MAINTENANCE_BYPASS_COOKIE_NAME, apiToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TOKEN_MAX_AGE_SEC,
  });
  return res;
}
