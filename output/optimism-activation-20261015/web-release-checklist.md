# Optimism frontend release checklist — 2026-10-15

Updated 2026-10-16 with the network selector and popup layout changes.
The current local frontend source builds successfully. Optimism source is still
unpublished: the checked-out `main` is `24bd21a` (`Trim idle MemeFun work and compress
catalog responses`), and the 28 web paths below are modified or untracked. Running
the existing workflow against that unchanged commit would build the old frontend.

## Required production build values

Preserve the full existing production environment and all other chain settings.
Replace/add these two public entries:

```dotenv
NEXT_PUBLIC_DUST_SWEEP_ENABLED_CHAINS=8453,1,56,42161,4663,10
NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_10=0x54c177426033d50686ba7d36b690d1a2d7e34625
```

Optional explicit defaults:

```dotenv
NEXT_PUBLIC_DUST_SWEEP_AUTO_SELECT_LIMIT_10=10
NEXT_PUBLIC_OPTIMISM_RPC_URL=https://mainnet.optimism.io
```

The OP selection limit defaults to 10. Without an explicit public RPC, wagmi/viem
uses the imported Optimism chain's default transport. `NEXT_PUBLIC_OPTIMISM_RPC_URLS`
optionally accepts comma-separated public browser-safe URLs. Server Alchemy keys,
deployer keys and other credentials must remain server-side. No OP public fee,
fee-recipient or paymaster setting is needed; the backend and contract supply fees.

## Where the values must be supplied

`NEXT_PUBLIC_*` values are baked into the browser bundle at build time. Updating
only a running Cloudflare Worker's runtime Variables & Secrets does not update
the chain selector or router config in an existing browser bundle.

The repository workflow `.github/workflows/deploy-web.yml` writes the GitHub Actions
secret `WEB_ENV_PRODUCTION` to `apps/web/.env.production`, runs the OpenNext build,
and deploys Cloudflare Worker `dustswap`. Preserve that secret's existing contents
and update the entries above before releasing the web source. Its existing
job-level `NEXT_PUBLIC_API_URL` and wallet settings remain unchanged.

If building through a different system, supply these entries to that system's
build environment. The built frontend must continue pointing at the existing
Railway API root through its existing `NEXT_PUBLIC_API_URL`.

## Exact source publication scope

Publish these 28 paths together. The first 19 are modifications; the final nine
are new files. No API source, actual environment files, generated build files,
private credentials, contract broadcasts, or unrelated MemeFun changes are
needed in this frontend-only source publication.

```text
apps/web/package.json
apps/web/src/app/dustsweep/page.tsx
apps/web/src/components/sweep/RouteDisplay.tsx
apps/web/src/components/sweep/SweepDetails.tsx
apps/web/src/components/sweep/SweepSuccessModal.tsx
apps/web/src/components/sweep/TokenFromPanel.tsx
apps/web/src/components/sweep/TokenLogo.tsx
apps/web/src/components/sweep/TokenSelectModal.tsx
apps/web/src/components/sweep/TokenToPanel.tsx
apps/web/src/components/sweep/UnavailablePanel.tsx
apps/web/src/config/sweepChainConfig.ts
apps/web/src/config/web3.ts
apps/web/src/hooks/useDustSweep.ts
apps/web/src/types/dustsweep.ts
apps/web/src/app/globals.css
apps/web/src/components/AppShell.tsx
apps/web/src/components/sweep/SlippageSettings.tsx
apps/web/src/components/sweep/SweepGuideModal.tsx
apps/web/src/components/sweep/SweepCampaignModal.tsx
apps/web/public/dex/optimism.png
apps/web/public/dex/velodrome.svg
apps/web/src/lib/dustsweep-results.ts
apps/web/tests/dustsweep-chain-parity.test.mjs
apps/web/tests/dustsweep-results.test.mjs
apps/web/public/dex/base.png
apps/web/src/components/sweep/SweepModal.tsx
apps/web/src/components/sweep/SweepNetworkSelect.tsx
apps/web/src/components/sweep/SweepNetworkIcon.tsx
```

These include OP chain/RPC configuration, official branding, discovery-filter
visibility, chain-aware wallet callbacks, actual aggregate minimum receive,
scoped actual receipt results, legacy Base receipt compatibility, and OKX
preflight-drop handling. `package.json` changes add test scripts; no new dependency
or lockfile change is required for this frontend work.

The 2026-10-16 additions provide square logo-only picker buttons, a header network
menu with one logo/name row per chain, readable network badges, and shared popup
centering that excludes the desktop sidebar. Browser checks and screenshots are
in `output/sweep-ui-20261016/README.md`.

## Local verification results

Run from `C:\dustswap\apps\web` with installed executables:

```powershell
node node_modules/typescript/bin/tsc --noEmit --incremental false
node --max-old-space-size=4096 node_modules/next/dist/bin/next build
```

- Fresh nonincremental TypeScript check: **PASS, zero diagnostics**.
- Full installed Next.js 15.1.11 production build: **PASS, exit 0**. Compilation,
  lint/type validation, 32 static pages, page optimization and build traces all
  completed; `/dustsweep` and all five sweep proxy routes were present.
- The previous admin import failures and four implicit-any diagnostics did not
  reproduce in this fresh run. The first sandboxed build hit Google Fonts DNS
  and `.next` generated-file permissions; the subsequent permitted local build
  completed without either failure.
- Nonblocking warnings remain for Browserslist age, the upstream ox/tempo dynamic
  dependency, image elements, and existing hook dependency lint rules.
- Prior focused regressions on this unchanged source passed **23/23**: nine
  receipt/results, eight chain/callback parity and six wallet-RPC cases.
- The production build used existing local environment files. It confirms source
  buildability, not the eventual production bundle's enabled-chain values.

No source publication, Cloudflare environment change or deployment was performed
for this checklist. No existing environment values or private credentials are
reproduced here. OpenNext packaging/deployment still belongs to the release job.

## Release order

1. Keep the root-managed Railway API release and OP configuration ready.
2. Supply the public production build values above in the actual web build system.
3. Publish the exact web source scope above through the normal reviewed release
   flow. A push affecting `apps/web/**` on `main` automatically triggers the web
   deployment workflow, so prepare build values before that push. A branch alone
   does not trigger this repository's production web deployment.
4. Build/deploy that new commit, then check `/dustsweep` shows Optimism and the
   same-origin quote/build endpoints accept chain 10. Changing only environment
   values and manually dispatching the old `main` is insufficient.

Wallet support still determines whether approvals and the consuming sweep fit
in one atomic wallet batch. Plain EOAs may require approval transactions. This
verification did not sign a connected-wallet mainnet sweep.
