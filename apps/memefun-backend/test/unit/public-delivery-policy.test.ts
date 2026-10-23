import { describe, expect, it } from "vitest";
import { isCid as mediaIsCid } from "../../lib/cid";
import { isCid, publicDeliveryConfig, publicDeliveryRedirectFor } from "../../lib/public-delivery-policy.mjs";

const canonical = "https://legacy-api.example";
const delivery = "https://cdn.example";
const config = publicDeliveryConfig(canonical, delivery);
const cid = "bafkreibfacd7wh35rmqzhfxa45jfkb7iotcvfxnhbbxygvtmjiupa4meye";

describe("native gateway public delivery policy", () => {
  it("uses the same CID validator as publishing and media reads", () => {
    expect(mediaIsCid).toBe(isCid);
    expect(isCid(cid)).toBe(true);
    expect(isCid("not-a-cid")).toBe(false);
  });

  it.each(["GET", "HEAD"])("returns the complete %s redirect, including query bytes and cache isolation", method => {
    expect(publicDeliveryRedirectFor(config, {
      method, url: `${canonical}/v1/coins?cursor=page%2b2&sort=new&sort=top`, headers: {},
    })).toEqual({
      status: 307,
      location: `${delivery}/v1/coins?cursor=page%2b2&sort=new&sort=top`,
      headers: { "cache-control": "public, max-age=300", vary: "Authorization, Cookie, X-Admin-Token, Range" },
    });
  });

  it.each(["authorization", "cookie", "x-admin-token", "range"])("bypasses %s supplied as an array by a native HTTP caller", name => {
    expect(publicDeliveryRedirectFor(config, {
      method: "GET", url: `${canonical}/media/${cid}`, headers: { [name]: ["", "private"] },
    })).toBeUndefined();
  });

  it("allows an empty credential header while retaining the actual-host check", () => {
    const result = publicDeliveryRedirectFor(config, {
      method: "GET", url: `${canonical}/v1/stats`, headers: { authorization: "   ", "x-forwarded-host": "other.example" },
    });
    expect(result?.location).toBe(`${delivery}/v1/stats`);
    expect(publicDeliveryRedirectFor(config, {
      method: "GET", url: "https://other.example/v1/stats", headers: { "x-forwarded-host": "legacy-api.example" },
    })).toBeUndefined();
  });

  it("never redirects a CDN alias request back to itself", () => {
    expect(publicDeliveryRedirectFor(config, { method: "GET", url: `${delivery}/v1/coins`, headers: {} })).toBeUndefined();
  });

  it("leaves body-bearing methods and non-public media paths for the application", () => {
    expect(publicDeliveryRedirectFor(config, { method: "POST", url: `${canonical}/v1/coins`, headers: {} })).toBeUndefined();
    for (const path of [`/media/${cid}/file`, "/media/not-a-cid", "/v1/author/me", "/v1/launch-campaign", "/status", "/v1/stream"]) {
      expect(publicDeliveryRedirectFor(config, { method: "GET", url: canonical + path, headers: {} })).toBeUndefined();
    }
  });
});
