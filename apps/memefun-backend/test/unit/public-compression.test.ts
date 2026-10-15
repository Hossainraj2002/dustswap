import { gunzipSync, gzipSync } from "node:zlib";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { cachedJson } from "../../api/http";
import { publicCatalogCompression } from "../../api/public-compression";
import { publicDeliveryConfig, publicDeliveryRedirect } from "../../api/public-delivery";

const canonical = "https://memefun-api-production.up.railway.app";
const delivery = "https://memefun-api.dustswap.wtf";
const body = { coins: Array.from({ length: 40 }, (_, index) => ({ address: `0x${String(index).padStart(40, "0")}`,
  name: `MemeFun token ${index} 🪙`, symbol: `MEME${index}`, description: "A public token catalog record. ".repeat(8),
  quote: { symbol: index % 2 ? "USDC" : "ETH", decimals: index % 2 ? 6 : 18 }, liquidity: "1000000000000000000000" })),
  nextCursor: "page+2", total: 80, asOf: 1_792_080_000_000 };

type Fixture = { status?: 200 | 206 | 304 | 400 | 401 | 404 | 429 | 500; control?: string; contentType?: string;
  vary?: string; encoding?: string; bytes?: Uint8Array; length?: string; setCookie?: boolean; delivery?: boolean; tiny?: boolean };
function makeApp(options: Fixture = {}) {
  const app = new Hono();
  if (options.delivery) app.use("*", publicDeliveryRedirect(publicDeliveryConfig(canonical, delivery)));
  app.use("*", publicCatalogCompression());
  app.all("*", c => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Vary", options.vary ?? "Origin");
    const payload = options.tiny ? { coins: [], nextCursor: null, total: 0 } : body;
    const responseHeaders = { "Content-Type": options.contentType ?? "application/json; charset=utf-8", "Cache-Control": "public, max-age=2" };
    const result = options.status === 304 ? c.body(null, 304, responseHeaders)
      : options.status && options.status !== 200
      ? c.body(JSON.stringify(payload), options.status, responseHeaders)
      : options.bytes
        ? new Response(options.bytes, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=2" } })
        : cachedJson(c, payload, { maxAge: 2 });
    if (options.control !== undefined) result.headers.set("Cache-Control", options.control);
    if (options.contentType !== undefined) result.headers.set("Content-Type", options.contentType);
    if (options.encoding) result.headers.set("Content-Encoding", options.encoding);
    if (options.length) result.headers.set("Content-Length", options.length);
    if (options.setCookie) result.headers.set("Set-Cookie", "session=test; HttpOnly; Secure");
    return result;
  });
  return app;
}

const request = (app: Hono, headers: Record<string, string> = {}, path = "/v1/coins?sort=new&limit=40") => app.request(delivery + path, { headers: { "Accept-Encoding": "gzip", ...headers } });

describe("anonymous public catalog compression", () => {
  it("emits actual gzip with identical decoded JSON, smaller bytes, and unchanged public/CORS headers", async () => {
    const response = await request(makeApp());
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(bytes).toString())).toEqual(body);
    expect(bytes.length).toBeLessThan(Buffer.byteLength(JSON.stringify(body)) / 5);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=2, stale-while-revalidate=10");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Vary")).toBe("Origin, Accept-Encoding");
    expect(response.headers.get("ETag")).toMatch(/^W\/".+"$/);
    expect(response.headers.has("Content-Length")).toBe(false);
  });

  it.each(["identity", "gzip;q=0", "gzip;q=0, *;q=1", "br, deflate", "*;q=0", ""])("respects a client that does not accept gzip: %s", async encoding => {
    const response = await request(makeApp(), { "Accept-Encoding": encoding });
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("ETag")).toMatch(/^".+"$/);
  });

  it.each(["gzip;q=0.5", "br, gzip", "*;q=1", "GZIP"])("negotiates accepted gzip: %s", async encoding => {
    const response = await request(makeApp(), { "Accept-Encoding": encoding });
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString())).toEqual(body);
  });

  it("returns an unencoded zero-body 304 for weak or strong validators from either representation", async () => {
    const app = makeApp();
    const compressed = await request(app); await compressed.arrayBuffer();
    const weak = compressed.headers.get("ETag")!;
    for (const tag of [weak, weak.slice(2), `"other", ${weak}`]) {
      const response = await request(app, { "If-None-Match": tag });
      expect(response.status).toBe(304);
      expect(response.headers.get("Vary")).toBe(compressed.headers.get("Vary"));
      expect(response.headers.get("Cache-Control")).toBe(compressed.headers.get("Cache-Control"));
      expect(response.headers.get("ETag")?.replace(/^W\//, "")).toBe(weak.slice(2));
      expect(response.headers.has("Content-Encoding")).toBe(false);
      expect(await response.text()).toBe("");
    }
    const plain = await request(app, { "Accept-Encoding": "identity" }); await plain.text();
    const response = await request(app, { "If-None-Match": plain.headers.get("ETag")! });
    expect(response.status).toBe(304);
    expect(response.headers.get("Vary")).toBe(plain.headers.get("Vary"));
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(await response.text()).toBe("");
  });

  it.each(["Authorization", "AUTHORIZATION", "Cookie", "cookie", "X-Admin-Token", "Range"])("does not transform requests carrying %s", async name => {
    const app = makeApp();
    const response = await request(app, { [name]: "private-or-range-value" });
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Vary")).toBe("Origin");
    const conditional = await request(app, { [name]: "private-or-range-value", "If-None-Match": response.headers.get("ETag")! });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("Vary")).toBe("Origin");
    expect(conditional.headers.has("Content-Encoding")).toBe(false);
    expect(await conditional.text()).toBe("");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])("leaves %s untouched", async method => {
    const response = await makeApp().request(delivery + "/v1/coins", { method, headers: { "Accept-Encoding": "gzip" } });
    expect(response.headers.has("Content-Encoding")).toBe(false);
    if (method === "HEAD") expect(await response.text()).toBe("");
    else expect(await response.json()).toEqual(body);
  });

  it.each(["/v1/coins/0x123", "/v1/coins/", "/v1/stream", "/v1/positions/0x123", "/v1/auth/nonce", "/v1/author/me", "/v1/launch-campaign", "/v1/claimables/0x123", "/media/cid"])("does not compress other routes: %s", async path => {
    const response = await request(makeApp(), {}, path);
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(await response.json()).toEqual(body);
  });

  it.each([206, 304, 400, 401, 404, 429, 500] as const)("does not compress status %s", async status => {
    const response = await request(makeApp({ status }));
    expect(response.status).toBe(status);
    expect(response.headers.has("Content-Encoding")).toBe(false);
    await response.arrayBuffer();
  });

  it.each(["private, max-age=2", "public, no-store", "public, no-cache", "public, private=\"token\"", "max-age=2", ""])("does not compress a response without eligible public cache policy: %s", async control => {
    const response = await request(makeApp({ control }));
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(await response.json()).toEqual(body);
  });

  it.each(["public, no-transform, max-age=2", "public, NO-TRANSFORM"])("respects no-transform: %s", async control => {
    const app = makeApp({ control });
    const response = await request(app);
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(await response.json()).toEqual(body);
    const conditional = await request(app, { "If-None-Match": response.headers.get("ETag")! });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("Vary")).toBe("Origin");
    expect(conditional.headers.has("Content-Encoding")).toBe(false);
    expect(await conditional.text()).toBe("");
  });

  it("does not recompress an already encoded response", async () => {
    const bytes = gzipSync(JSON.stringify(body));
    const response = await request(makeApp({ encoding: "gzip", bytes }));
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("does not compress non-JSON, cookie-setting, or explicitly small responses", async () => {
    for (const options of [{ contentType: "text/event-stream" }, { contentType: "text/plain" }, { setCookie: true }, { tiny: true, length: "40" }]) {
      const response = await request(makeApp(options));
      expect(response.headers.has("Content-Encoding")).toBe(false);
      await response.arrayBuffer();
    }
  });

  it("keeps existing Vary tokens without duplicating Accept-Encoding", async () => {
    for (const vary of ["Origin, accept-encoding", "*"]) {
      const app = makeApp({ vary });
      const response = await request(app);
      expect(response.headers.get("Vary")).toBe(vary);
      expect(response.headers.get("Content-Encoding")).toBe("gzip");
      await response.arrayBuffer();
      const conditional = await request(app, { "If-None-Match": response.headers.get("ETag")! });
      expect(conditional.status).toBe(304);
      expect(conditional.headers.get("Vary")).toBe(vary);
      expect(conditional.headers.has("Content-Encoding")).toBe(false);
    }
  });

  it("leaves the legacy redirect uncompressed and preserves its query exactly", async () => {
    const response = await makeApp({ delivery: true }).request(canonical + "/v1/coins?sort=new&limit=200&cursor=page%2B2", { headers: { "Accept-Encoding": "gzip" } });
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(delivery + "/v1/coins?sort=new&limit=200&cursor=page%2B2");
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(response.headers.get("Vary")).toBe("Authorization, Cookie, X-Admin-Token, Range");
    expect(await response.text()).toBe("");
  });
});
