/* global URL */
/** The API and its sleeping gateway share this policy without loading application dependencies. */

// These exact routes contain no wallet-specific data and are eligible for the CDN cache.
const PUBLIC_READS = new Set([
  "/v1/coins", "/v1/activity", "/v1/stats", "/v1/platform-token", "/v1/deployment",
  "/v1/launch-settings", "/v1/pair-catalog", "/v1/moderation", "/v1/search", "/v1/creators/top",
]);
const PRIVATE_HEADERS = ["authorization", "cookie", "x-admin-token", "range"];
const REDIRECT_HEADERS = Object.freeze({
  "cache-control": "public, max-age=300",
  vary: "Authorization, Cookie, X-Admin-Token, Range",
});

/** CIDv1 base32 or CIDv0 base58btc shape only, matching the media store's existing validation. */
const CID_PATTERN = /^(?:b[a-z2-7]{50,120}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
export function isCid(value) {
  return CID_PATTERN.test(value);
}

/** Publishing keeps its original URLs; only delivery of anonymous reads moves to the CDN. */
export function publicDeliveryConfig(canonical, delivery) {
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

/**
 * Returns the same anonymous-read redirect for Hono and the native HTTP gateway.
 * Headers are supplied with lowercase names, as in Node's IncomingHttpHeaders.
 * The actual absolute request URL is authoritative; forwarded hosts are ignored.
 */
export function publicDeliveryRedirectFor(config, request) {
  if (!config || (request.method !== "GET" && request.method !== "HEAD")) return undefined;
  if (PRIVATE_HEADERS.some(name => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value.join(",") : value)?.trim();
  })) return undefined;
  const url = new URL(request.url);
  if (url.host !== config.canonical.host) return undefined;
  const media = /^\/media\/([^/]+)$/.exec(url.pathname);
  const cid = media?.[1];
  if (!PUBLIC_READS.has(url.pathname) && !(cid && isCid(cid))) return undefined;
  const target = new URL(config.delivery.origin);
  target.pathname = url.pathname;
  target.search = url.search;
  return { status: 307, location: target.href, headers: REDIRECT_HEADERS };
}
