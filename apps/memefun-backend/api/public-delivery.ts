import type { MiddlewareHandler } from "hono";
import { isCid } from "../lib/cid";

export interface PublicDelivery {
  canonical: URL;
  delivery: URL;
}

// These exact routes contain no wallet-specific data and are eligible for the CDN cache.
const PUBLIC_READS = new Set([
  "/v1/coins", "/v1/activity", "/v1/stats", "/v1/platform-token", "/v1/deployment",
  "/v1/launch-settings", "/v1/pair-catalog", "/v1/moderation", "/v1/search", "/v1/creators/top",
]);

/** Publishing keeps its original URLs; only delivery of anonymous reads moves to the CDN. */
export function publicDeliveryConfig(canonical: string | undefined, delivery: string | undefined): PublicDelivery | undefined {
  if (!delivery) return undefined;
  if (!canonical) throw new Error("PUBLIC_API_URL is required with PUBLIC_DELIVERY_URL.");
  const source = new URL(canonical);
  const target = new URL(delivery);
  for (const value of [source, target]) {
    if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/" || value.search || value.hash) {
      throw new Error("Public delivery URLs must be HTTPS origins without credentials, paths, queries or fragments.");
    }
  }
  if (source.host === target.host) throw new Error("Public delivery requires a separate CDN hostname.");
  return { canonical: source, delivery: target };
}

/** Avoid old app sessions downloading entire catalogs/media directly from the Railway origin. */
export function publicDeliveryRedirect(config: PublicDelivery | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!config || (c.req.method !== "GET" && c.req.method !== "HEAD")) return next();
    if (["authorization", "cookie", "x-admin-token", "range"].some(name => c.req.header(name)?.trim())) return next();
    const request = new URL(c.req.url);
    // Compare the actual request host, never forwarded headers supplied by a caller. Requests
    // on the CDN alias must serve the original body so the proxy can populate its cache.
    if (request.host !== config.canonical.host) return next();
    const media = /^\/media\/([^/]+)$/.exec(request.pathname);
    const cid = media?.[1];
    if (!PUBLIC_READS.has(request.pathname) && !(cid && isCid(cid))) return next();
    const target = new URL(config.delivery.origin);
    target.pathname = request.pathname;
    target.search = request.search;
    // Temporary and short-lived for a straightforward rollback; metadata itself stays canonical.
    c.header("Cache-Control", "public, max-age=300");
    c.header("Vary", "Authorization, Cookie, X-Admin-Token, Range");
    return c.redirect(target.href, 307);
  };
}
