import { type NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { COUNTRY_COOKIE } from "@/lib/geo";

/** The visitor's country as Cloudflare sees it: the CF-IPCountry header, else the request's cf data. */
function countryOf(request: NextRequest): string | null {
  const header = request.headers.get("cf-ipcountry");
  if (header && /^[A-Za-z]{2}$/.test(header)) return header.toUpperCase();
  try {
    const country = (getCloudflareContext().cf as { country?: unknown } | undefined)?.country;
    if (typeof country === "string" && /^[A-Za-z]{2}$/.test(country)) return country.toUpperCase();
  } catch {
    // Not running on Cloudflare (next dev): no country, nothing restricted.
  }
  return null;
}

/** Stores the visitor's country for the stock-pair geofence (lib/geo.ts). */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const country = countryOf(request);
  if (country && request.cookies.get(COUNTRY_COOKIE)?.value !== country) {
    response.cookies.set(COUNTRY_COOKIE, country, { path: "/", sameSite: "lax", secure: true, maxAge: 60 * 60 });
  }
  return response;
}

export const config = {
  // Pages only: not build assets, images or other files.
  matcher: ["/((?!_next/static|_next/image|.*\\.[A-Za-z0-9]+$).*)"],
};
