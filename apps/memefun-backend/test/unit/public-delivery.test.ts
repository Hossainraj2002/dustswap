import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { publicDeliveryConfig, publicDeliveryRedirect } from "../../api/public-delivery";

const canonical = "https://memefun-api-production.up.railway.app";
const delivery = "https://memefun-api.dustswap.wtf";
const cid = "bafkreibfacd7wh35rmqzhfxa45jfkb7iotcvfxnhbbxygvtmjiupa4meye";
const makeApp = (enabled = true) => {
  const app = new Hono();
  app.use("*", publicDeliveryRedirect(enabled ? publicDeliveryConfig(canonical, delivery) : undefined));
  app.all("*", c => c.json({ original: true }));
  return app;
};

describe("public delivery", () => {
  it("is opt-in and rejects unsafe origin configuration", () => {
    expect(publicDeliveryConfig(undefined, undefined)).toBeUndefined();
    expect(() => publicDeliveryConfig(undefined, delivery)).toThrow();
    for (const target of [canonical, "http://cdn.test", "https://user:pass@cdn.test", "https://cdn.test/path", "https://cdn.test/?a=1", "https://cdn.test/#fragment"]) {
      expect(() => publicDeliveryConfig(canonical, target)).toThrow();
    }
    expect(() => publicDeliveryConfig("http://api.test", delivery)).toThrow();
  });
  it("preserves the complete public read query while redirecting old clients", async () => {
    const response = await makeApp().request(`${canonical}/v1/coins?sort=new&limit=200&cursor=page%2B2`);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${delivery}/v1/coins?sort=new&limit=200&cursor=page%2B2`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("vary")).toContain("Authorization");
  });
  it.each(["/v1/coins", "/v1/activity", "/v1/stats", "/v1/platform-token", "/v1/deployment", "/v1/launch-settings", "/v1/pair-catalog", "/v1/moderation", "/v1/search", "/v1/creators/top", `/media/${cid}`])("moves anonymous %s to the CDN", async path => {
    const response = await makeApp().request(canonical + path);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(delivery + path);
  });
  it("serves CDN alias requests directly without a redirect loop", async () => {
    const response = await makeApp().request(delivery + "/v1/coins");
    expect(response.status).toBe(200);
    expect(response.headers.has("location")).toBe(false);
    expect(await response.json()).toEqual({ original: true });
  });
  it("does not trust forwarded hosts or redirect unconfigured hosts", async () => {
    const response = await makeApp().request("https://other.test/v1/coins", { headers: { "x-forwarded-host": new URL(canonical).host } });
    expect(response.status).toBe(200);
  });
  it.each(["Authorization", "AUTHORIZATION", "Cookie", "cookie", "X-Admin-Token", "Range"])("never redirects requests carrying %s", async name => {
    const response = await makeApp().request(canonical + "/v1/coins", { headers: { [name]: "private-value" } });
    expect(response.status).toBe(200);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("cache-control")).toBe(false);
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("leaves %s requests on their original host", async method => {
    expect((await makeApp().request(canonical + "/v1/coins", { method })).status).toBe(200);
  });
  it.each(["/v1/stream", "/v1/auth/nonce", "/v1/author/me", "/v1/launch-campaign", "/v1/launch-campaign/wallets/0x123", "/v1/positions/0x123", "/v1/claimables/0x123", "/v1/admin/coins", "/media/not-a-cid", `/media/${cid}/other`, "/v1/coins/0x123"])("leaves private, streaming or other routes untouched: %s", async path => {
    expect((await makeApp().request(canonical + path)).status).toBe(200);
  });
  it("leaves all routes untouched when delivery is not configured", async () => {
    expect((await makeApp(false).request(canonical + `/media/${cid}`)).status).toBe(200);
  });
  it("supports anonymous HEAD without a response body", async () => {
    const response = await makeApp().request(canonical + `/media/${cid}`, { method: "HEAD" });
    expect(response.status).toBe(307);
    expect(await response.text()).toBe("");
  });
});
