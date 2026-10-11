# MemeFun API bandwidth controls

Production delivery uses `https://memefun-api.dustswap.wtf` on the existing Railway API service, proxied by Cloudflare. The frontend build variable `NEXT_PUBLIC_MEMEFUN_API_URL` points at that hostname.

Keep backend `PUBLIC_API_URL=https://memefun-api-production.up.railway.app`. Published bucket metadata and on-chain token URIs already contain that canonical origin, and publication checks compare against it. The frontend rewrites only known canonical `/media/<CID>` image URLs for display. It does not change persisted metadata, token URIs, or third-party image URLs.

## Client requests

- Full discovery/search catalogs reconcile every 60 seconds while streaming is healthy. Trades and launches refresh the affected coin, rather than reloading every historical token.
- A disconnected stream retains a 10-second full-catalog fallback. All catalog pages remain available; there is no token-count truncation.
- Hidden tabs suspend passive market polling and streaming, abort a paginated catalog fetch, and refresh when visible again.
- A closed search dialog does not subscribe to the full catalog. Existing readers expire through the normal 30-second keep-alive window.
- Pinned platform-token identity refreshes every 60 seconds. Trading detail, quotes, pool checks, and transaction freshness retain their existing behavior.

Changing scheduled catalog reconciliation from five to 60 seconds means 91.7% fewer scheduled full-catalog downloads per active catalog reader. This is not a measured reduction in the total Railway bill: streaming events, direct-origin clients, other routes, and cache-hit rates affect actual bandwidth.

## Cloudflare cache policy

Zone `d14363962fff515a27e309c9cc39184f`; entry-point ruleset `bcb177c64b9a4fdb9ecc22ef5af7633e`, phase `http_request_cache_settings`.

Rules apply only to `memefun-api.dustswap.wtf`, in this order:

1. Bypass by default.
2. Eligible anonymous GETs for these exact public paths: `/v1/coins`, `/v1/activity`, `/v1/stats`, `/v1/platform-token`, `/v1/deployment`, `/v1/launch-settings`, `/v1/pair-catalog`, `/v1/moderation`, `/v1/search`, `/v1/creators/top`.
3. Eligible anonymous GETs under `/media/`.
4. Bypass requests with nonempty Authorization, Cookie, or X-Admin-Token headers, regardless of header-name case.

Eligible rules preserve query-string cache keys, respect origin browser TTL, and use `edge_ttl.mode=bypass_by_default`. They do not force a TTL, cache errors, override origin `no-store`, or force stale-on-error. Coin-list responses retain their two-second cache policy; the public platform-token summary uses five seconds without a stale grace period. Media uses its existing one-year immutable header. The explicit browser setting avoids applying the zone's default four-hour browser TTL to live JSON.

Authentication, wallet-specific endpoints, all writes, errors, and SSE remain uncached. Verify new routes before extending the public allowlist. Cloudflare does not cache extensionless CID paths or JSON by default; the eligibility rules are required.

Public JSON and media support weak/list/wildcard If-None-Match validation. Media validators still check the stored object before returning a zero-body 304. Railway already compresses JSON for browsers; there is no duplicate application gzip middleware.

## Verification and operations

On 11 October 2026, the new hostname passed normal HTTPS and CORS checks, public JSON and media MISS-to-HIT probes, credential bypass checks, wallet-data no-store/private checks, SSE ready-event delivery, preflight, and repeated 400/404 non-caching checks. Automated validation passed 791 frontend and 359 backend tests, both type checks, and a frontend production build using the CDN hostname.

Compare hourly API NETWORK_TX_GB and HTTP route counts over similar traffic windows after deployment. Record Cloudflare HIT/MISS/EXPIRED/BYPASS ratios as well: origin request counts alone cannot measure image byte savings. Existing clients using the original Railway hostname bypass Cloudflare until they reload the updated app; external direct-origin traffic also remains possible. Do not claim an exact bill reduction before comparable live measurements.

Rollback: restore the frontend build variable to the original Railway API hostname and rebuild/redeploy the web service. The display mapping follows the configured API automatically. The original API hostname remains available. Cache rules can be disabled for the alias without modifying canonical metadata or deploying contracts. Do not remove canonical media serving: older published URLs depend on it.

Official references: [Cloudflare default caching](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) and [Cache Rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).
