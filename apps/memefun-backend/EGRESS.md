# MemeFun API bandwidth controls

Production delivery uses `https://memefun-api.dustswap.wtf` on the existing Railway API service, proxied by Cloudflare. The frontend build variable `NEXT_PUBLIC_MEMEFUN_API_URL` points at that hostname.

Keep backend `PUBLIC_API_URL=https://memefun-api-production.up.railway.app`. Published bucket metadata and on-chain token URIs already contain that canonical origin, and publication checks compare against it. The frontend rewrites only known canonical `/media/<CID>` image URLs for display. It does not change persisted metadata, token URIs, or third-party image URLs.

Set the separate optional API variable `PUBLIC_DELIVERY_URL=https://memefun-api.dustswap.wtf` only after the keeper supports direct authenticated reads of this store's canonical HTTPS metadata URLs. This redirects anonymous legacy-host public reads and valid `/media/<CID>` reads to the CDN with a temporary 307, preserving the complete query. Redirects are cached for five minutes and vary on credential/Range headers. Alias requests serve normal bodies without looping. Wallet, claim, auth, streaming, write, credential-bearing, and unlisted routes are not redirected. Leaving the variable unset preserves the original delivery behavior.

## Client requests

- Full discovery/search catalogs reconcile every 60 seconds while streaming is healthy. Trades and launches refresh the affected coin, rather than reloading every historical token.
- A disconnected stream retains a 10-second full-catalog fallback. All catalog pages remain available; there is no token-count truncation.
- Hidden tabs suspend passive market polling and streaming, abort a paginated catalog fetch, and refresh when visible again.
- A closed search dialog does not subscribe to the full catalog. Existing readers expire through the normal 30-second keep-alive window.
- A closed wallet account sheet does not subscribe to all supported token balances. Visible trade views poll only requested assets; opening the account sheet still loads all balances it displays. Balance refresh cadence and post-transaction invalidation are preserved.
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

## Keeper and resource costs

### Quiet-market operation

The API's shared market snapshot rebuilds every ten seconds for quiet readers, rather than every two seconds. With no stream subscribers and no real market read for twenty seconds, it uses a one-minute background heartbeat. Health checks do not extend reader interest. The next real read (including admin overview) waits for an in-flight build and refreshes a snapshot that is at least ten seconds old before returning. Observed stream trades/activity trigger a coalesced refresh and retain the two-second cadence for twenty seconds. This means 80% fewer scheduled full rebuilds for quiet readers, or 96.7% fewer during fully idle periods compared with the original two-second loop; neither number is a total billing reduction. Explicit write/admin refreshes remain immediate. Rolling windows, holder balances, quote changes, multi-pool history and moderation continue updating for interested readers within the quiet bound.

The event hub performs no database polls without subscribers. Active streams retain their one-second polling cadence, initialize a fresh cursor on reconnect, and refresh the snapshot before deriving new trade/activity events. In-flight work from a previous audience cannot replay to a new one. A failed batch does not advance its cursors.

Share-card PNG storage is bounded to 16 MiB and 128 entries, with fixed one-minute expiry and concurrent requests for the same card sharing one render. Expired PNGs are released while idle. This limits retained cache data, not all HTTP rendering memory or total process RAM.

Uploads, keeper image processing and share-card renders also use one configured Sharp instance with an 8 MB native operation-cache budget, at most 32 cached operations and no cached open files. Image dimensions, encoding, quality, validation and concurrency selection are unchanged. Temporary decoding/rendering buffers are outside these retained-cache budgets.

Keeper metadata discovery uses a bounded database anti-join against the existing `memefun_app.coin_metadata` table and one batched, idempotent enqueue. Names/symbols are fetched only for the twenty due work items. Known resolved/unsupported records, retry limits, backoff and immutable queued URIs are preserved. The two schemas must remain in the same Postgres database, as in the existing deployment. No new migration is required.

The keeper retains only pending job timers, instead of keeping every timer handle after it fires. A stock-price job with an explicitly disabled (`none`) source returns before unnecessary database or RPC reads. Job frequencies, financial thresholds and transaction rules are unchanged. Own-store canonical HTTPS metadata and image URLs resolve directly through the authenticated media store with CID and byte-size checks; arbitrary remote redirects remain rejected.

Railway DNS and network-flow checks confirmed that the API and keeper already use private Postgres networking. Service CPU/RAM ceilings are not their metered usage; lowering a ceiling alone does not reduce the bill. Keep the active database and indexer running. An idle legacy database had a small measured footprint, so it was not deleted or disabled as part of this optimization.

Public JSON and media support weak/list/wildcard If-None-Match validation. Media validators still check the stored object before returning a zero-body 304. Anonymous exact `GET /v1/coins` catalog responses also use gzip inside the application when the client accepts it, before response bytes leave the container. The existing Hono compressor manages encoding negotiation, `Vary: Accept-Encoding` and weak ETags. Private/authenticated, range, write, HEAD, streaming, errors, 304, already encoded and `no-transform` responses bypass this path. Other routes retain existing edge compression. Measuring browser gzip alone cannot prove which bytes Railway meters; compare container network flow and comparable usage windows.

### Direct runtime launchers

Keep the API, web and keeper in separate services with their existing secrets. Their runtime commands invoke the same installed entry points directly, avoiding persistent package-manager/CLI wrappers. Under Railpack's shell start command, `exec` replaces the shell and delivers shutdown signals directly:

```sh
# API (apps/memefun-backend)
exec node node_modules/ponder/dist/esm/bin/ponder.js start --schema $RAILWAY_DEPLOYMENT_ID --views-schema memefun_mainnet --port $PORT
# Web (apps/memefun)
exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port $PORT
# Keeper (apps/memefun-backend)
exec node --import tsx keeper/main.ts
```

Do not execute keeper main locally against production environment values just to smoke-test a launcher. Validate installed CLI versions and the `tsx` loader with harmless modules, then check production startup and job logs. Preserve deployment/schema/port flags and existing working directories. Revalidate entry points after dependency upgrades. Roll back launcher changes to the previous `pnpm exec ponder ...`, `pnpm exec next ...` and `pnpm keeper` commands if startup fails. Wrapper memory savings require stable post-deployment measurements; no memory hard limit or heap cap is introduced.

## Verification and operations

On 11 October 2026, the new hostname passed normal HTTPS and CORS checks, public JSON and media MISS-to-HIT probes, credential bypass checks, wallet-data no-store/private checks, SSE ready-event delivery, preflight, and repeated 400/404 non-caching checks. Automated validation passed 791 frontend and 359 backend tests, both type checks, and a frontend production build using the CDN hostname.

Compare hourly API NETWORK_TX_GB and HTTP route counts over similar traffic windows after deployment. Record Cloudflare HIT/MISS/EXPIRED/BYPASS ratios as well: origin request counts alone cannot measure image byte savings. Existing clients using the original Railway hostname bypass Cloudflare until they reload the updated app or the optional legacy redirects are enabled. Credential-bearing and unlisted direct-origin traffic remains possible. Do not claim an exact bill reduction before comparable live measurements.

Rollout of legacy redirects: deploy the keeper's own-store metadata compatibility change first, then deploy the API with `PUBLIC_DELIVERY_URL` enabled. This avoids redirecting a media URL while an older keeper still rejects redirects. Verify legacy 307-to-CDN-200/HIT, unchanged private routes, and keeper metadata resolution.

Rollback: remove `PUBLIC_DELIVERY_URL` and redeploy the API, then restore the frontend build variable to the original Railway API hostname and rebuild/redeploy the web service. Browsers may retain temporary redirects for up to five minutes. The display mapping follows the configured API automatically. The original API hostname remains available. Cache rules can be disabled for the alias without modifying canonical metadata or deploying contracts. Do not remove canonical media serving: older published URLs depend on it.

Official references: [Cloudflare default caching](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) and [Cache Rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).
