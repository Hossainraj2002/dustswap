# DustSwap Site

Marketing site for `dustswap.wtf`. The product app remains at `app.dustswap.wtf`.

## Local

```bash
pnpm install
pnpm dev
```

## Verify

```bash
pnpm type-check
pnpm build
pnpm exec wrangler deploy --dry-run
```

## Deploy To Cloudflare

```bash
pnpm deploy
```

The site is exported as static Next.js output in `out/`, then served by a
Cloudflare Worker with static assets. The Worker is configured as `dustswap-site`
and attaches to the custom domain `dustswap.wtf` through `wrangler.jsonc`.

Before first deploy, make sure the Cloudflare account has the `dustswap.wtf`
zone and that no conflicting DNS record already owns the root hostname.

## Cloudflare Git Build Settings

If deploying from the Cloudflare dashboard, do not use a local Windows path.
Cloudflare clones the repository into Linux, so `C:\dustswap\apps\site` will fail
with `root directory not found`.

Use one of these configurations.

### Workers Builds

- Root directory: `apps/site`
- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Deploy command: `pnpm exec wrangler deploy --keep-vars`
- Node version: `22`

### Pages

- Root directory: `apps/site`
- Framework preset: `Next.js`
- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Build output directory: `out`
- Node version: `22`

If Cloudflare still says `root directory not found`, confirm the selected Git
branch contains `apps/site/package.json`.
