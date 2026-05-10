import { NextResponse } from "next/server";
import { MAINTENANCE_BYPASS_COOKIE_NAME } from "@/lib/maintenanceBypassToken";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MAINTENANCE_BYPASS_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
