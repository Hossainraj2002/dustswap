import { NextResponse } from "next/server";
import { buildPublicApiUrl } from "@/lib/apiBase";
import { maintenanceBypassHeadersFromRequest } from "@/lib/maintenanceForward";

export async function proxyDustSweepRequest(request: Request, path: string) {
  const body = request.method === "GET" ? undefined : await request.text();
  const bypass = await maintenanceBypassHeadersFromRequest(request);
  const response = await fetch(buildPublicApiUrl(path), {
    method: request.method,
    headers: {
      "Content-Type": request.headers.get("Content-Type") || "application/json",
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
