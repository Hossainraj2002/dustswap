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
pnpm exec opennextjs-cloudflare build
```

## Deploy To Cloudflare

```bash
pnpm deploy
```

The Worker is configured as `dustswap-site` and attaches to the custom domain
`dustswap.wtf` through `wrangler.jsonc`.

Before first deploy, make sure the Cloudflare account has the `dustswap.wtf`
zone and that no conflicting DNS record already owns the root hostname.
