import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  MAINTENANCE_BYPASS_COOKIE_NAME,
  maintenanceBypassConfigured,
  verifyMaintenanceBypassToken,
} from "@/lib/maintenanceBypassToken";

const PUBLIC_FILE = /\.[^/]+$/;

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (process.env.MAINTENANCE_MODE !== "1") {
    return NextResponse.next();
  }

  if (
    pathname === "/maintenance" ||
    pathname.startsWith("/_next/") ||
    PUBLIC_FILE.test(pathname) ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return NextResponse.next();
  }

  const secret = process.env.MAINTENANCE_BYPASS_SECRET;
  if (maintenanceBypassConfigured(secret)) {
    const cookieToken = request.cookies.get(MAINTENANCE_BYPASS_COOKIE_NAME)?.value;
    const verified = await verifyMaintenanceBypassToken(cookieToken, secret);
    if (verified.ok) {
      return NextResponse.next();
    }
  }

  const url = request.nextUrl.clone();
  url.pathname = "/maintenance";
  url.search = "";

  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
