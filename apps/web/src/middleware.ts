import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const PUBLIC_FILE = /\.[^/]+$/;

export function middleware(request: NextRequest) {
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

  const url = request.nextUrl.clone();
  url.pathname = "/maintenance";
  url.search = "";

  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
