# Optimism production configuration — 2026-10-15

Railway production project `mellow-wisdom`, service `dustswap`, now has all 15
Optimism-related settings applied, including the enabled-chain list. Existing
chains remain `8453,1,56,42161,4663`; `10` is appended. The variables were first
saved without restart, then applied with the new API source deployment.

`railway-optimism.env.example` contains the public configuration and a Railway
reference, not an Alchemy credential. The user's existing Base Alchemy key pool
is referenced by `ALCHEMY_OPTIMISM_RPC_KEYS`. Railway resolved it to the same pool.
The configured key passed `eth_chainId` (`0xa`) and `alchemy_getTokenBalances` on
the official Optimism Alchemy endpoint. Public RPC also passed `eth_chainId`.
The global aggregator switch was already `true` and was preserved.

The production PostgreSQL migration `apps/api/sql/multichain_optimism.sql` was
applied transactionally and verified: one OP chain-registry row, eight active
token seeds with logos, and the existing unique `(chain_id,address)` index.
Non-OP token counts were 13,976 before and after the migration. The seed list is
metadata support; wallet discovery is not limited to eight tokens.

The deployed router is `0x54c177426033d50686ba7d36b690d1a2d7e34625`, verified on
Optimistic Etherscan. The backend OP fee override is 200 bps (2%). Its collector
is `0xE09495e955794708D4bC28045C46891cAf643733`.

## Railway API live; frontend release still required

The API-only release `c10a9afc-68b8-4e43-9da6-26232a6f06a5` became **SUCCESS**
at 2026-10-15T17:34:08.797Z, with one healthy running replica. Railway's normal
`pnpm run build` / `tsc` and `/health` deployment check passed. The existing Git
source connection, branch `main`, `/apps/api` root, networking and other service
configuration were preserved. The curated upload contained 57 source/config files,
no environment files, credentials, private data or unrelated MemeFun changes.
Its reviewed inventory and hashes are in `release-api-manifest.json`.

Actual production OP discovery passed using Alchemy, with no truncation/provider
warning. Four actual production quote/build cases passed: WETH→USDC, USDC→WETH,
USDC+WETH→native ETH in one sweep, and WETH passthrough→native ETH. Decoded calldata
matched the deployed router, expected recipient, 200 bps fee and production
allowance auth mode. Base's enabled gate also passed a lightweight validation check.
No environment override, database mock, signature or broadcast was used in these
production checks. See `production-smoke-2026-10-15T17-34-53-390Z.json`.

The full local API build and 34 API integration tests pass. The full local web
production build and fresh nonincremental TypeScript check also pass; earlier
type/admin-import/font-fetch issues did not reproduce with required access.

Git `main` still lacks the local OP API/web changes; no Git push was performed.
Publish those scoped source changes through the normal release flow before using
Git-based deployments again, so a later API rebuild does not restore older code.
Rebuild/deploy the matching web source after the user sets its build variables.
Complete a connected-wallet sweep before declaring the whole application live and
validated. The backend is live; Cloudflare release and live wallet execution remain.

## Cloudflare handoff

Merge `cloudflare-build.env.example` into the **existing full** GitHub Actions
secret `WEB_ENV_PRODUCTION`; preserve the remaining production variables. The
workflow `.github/workflows/deploy-web.yml` writes that secret to `.env.production`
before Next/OpenNext builds the Cloudflare Worker `dustswap`. Prepare that secret
before publishing the updated web source: a matching push to `main` triggers the
workflow. Use manual `workflow_dispatch` for later secret-only changes, since those
alone do not trigger a deployment. Cloudflare runtime variable changes alone
cannot update `NEXT_PUBLIC_*` values already embedded in the browser bundle.

No new public fee recipient, secret Alchemy key, wallet private key or paymaster
setting is required for OP. Keep existing API URL, wallet settings, other chains'
router addresses and execution settings. No Cloudflare setting was changed here.
The exact 19 frontend source paths, checks and release order are in
`web-release-checklist.md`.

Evidence: `database-preflight.json`, `database-migration.json`,
`railway-config-health.json` (saved configuration and API state before deployment),
`railway-deployment.json`, and `production-smoke-2026-10-15T17-34-53-390Z.json`
(successful live API checks after deployment). The configuration checker captures
credentials in memory and outputs only public settings, counts and RPC statuses.
