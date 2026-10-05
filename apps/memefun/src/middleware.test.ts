import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

vi.mock("@/lib/chain", () => ({ TARGET_CHAIN_ID: 8453 }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ cf: { country: "BD" } }) }));

afterEach(() => vi.unstubAllEnvs());

describe("mainnet geographic cookie", () => {
  it("uses trusted Cloudflare country on the configured public origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://memefun.dustswap.wtf");
    const request = new NextRequest("https://memefun.dustswap.wtf/create", {
      headers: { "cf-ray": "9af123456789abcd-DAC", "cf-ipcountry": "BD" },
    });
    const response = middleware(request);
    expect(response.cookies.get("mf-country")?.value).toBe("BD");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("clears previously eligible country when geography is missing or origin is alternate", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://memefun.dustswap.wtf");
    for (const [url, headers] of [
      ["https://memefun.dustswap.wtf/create", { cookie: "mf-country=BD" }],
      ["https://memefun-web.up.railway.app/create", { cookie: "mf-country=BD", "cf-ray": "9af123456789abcd-DAC", "cf-ipcountry": "BD" }],
    ] as const) {
      const response = middleware(new NextRequest(url, { headers }));
      expect(response.cookies.get("mf-country")?.value).toBe("");
      expect(response.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
    }
  });
});
