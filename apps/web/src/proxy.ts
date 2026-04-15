import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function isMaintenanceModeEnabled() {
  return process.env.MAINTENANCE_MODE === "1";
}

export function proxy(request: NextRequest) {
  if (!isMaintenanceModeEnabled()) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname === "/maintenance") {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/maintenance", request.url));
}

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
