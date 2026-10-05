import { type NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { COUNTRY_COOKIE, trustedStockCountry } from "@/lib/geo";
import { TARGET_CHAIN_ID } from "@/lib/chain";

/** The visitor's country as Cloudflare sees it: the CF-IPCountry header, else the request's cf data. */
function countryOf(request: NextRequest): string | null {
  const header = request.headers.get("cf-ipcountry");
  if (TARGET_CHAIN_ID === 8453) return trustedStockCountry({ hostname: request.nextUrl.hostname,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://memefun.dustswap.wtf", cfRay: request.headers.get("cf-ray"), country: header });
  if (header && /^[A-Za-z]{2}$/.test(header)) return header.toUpperCase();
  try {
    const country = (getCloudflareContext().cf as { country?: unknown } | undefined)?.country;
    if (typeof country === "string" && /^[A-Za-z]{2}$/.test(country)) return country.toUpperCase();
  } catch {
    // Not running on Cloudflare (next dev): no country, nothing restricted.
  }
  return null;
}

/** Stores the visitor's country for stock-pair UI eligibility (lib/geo.ts). */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const country = countryOf(request);
  if (country && request.cookies.get(COUNTRY_COOKIE)?.value !== country) {
    response.cookies.set(COUNTRY_COOKIE, country, { path: "/", sameSite: "lax", secure: true, maxAge: 60 * 60 });
  }
  if (!country && TARGET_CHAIN_ID === 8453) response.cookies.delete(COUNTRY_COOKIE);
  return response;
}

export const config = {
  // Pages only: not build assets, images or other files.
  matcher: ["/((?!_next/static|_next/image|.*\\.[A-Za-z0-9]+$).*)"],
};
