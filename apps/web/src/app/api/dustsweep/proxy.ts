import { NextResponse } from "next/server";
import { buildPublicApiUrl } from "@/lib/apiBase";
import { maintenanceBypassHeadersFromRequest } from "@/lib/maintenanceForward";

// Real browser IP for this request (Cloudflare sets cf-connecting-ip). Forwarded
// to the API as x-client-ip so its per-user dustsweep rate limit can bucket by
// the actual user instead of this proxy's single shared IP.
function getProxyClientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf?.trim()) return cf.trim();
  const xff = request.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  return request.headers.get("x-real-ip")?.trim() || "";
}

export async function proxyDustSweepRequest(request: Request, path: string) {
  const body = request.method === "GET" ? undefined : await request.text();
  const bypass = await maintenanceBypassHeadersFromRequest(request);
  const clientIp = getProxyClientIp(request);
  const response = await fetch(buildPublicApiUrl(path), {
    method: request.method,
    headers: {
      "Content-Type": request.headers.get("Content-Type") || "application/json",
      ...(clientIp ? { "x-client-ip": clientIp } : {}),
      ...bypass,
    },
    body,
    cache: "no-store",
  });
  const text = await response.text();

  return new NextResponse(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/json",
    },
  });
}
