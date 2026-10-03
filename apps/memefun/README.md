# memefun app

The memefun web app (Next.js 15 on Cloudflare Workers through OpenNext). Apple HIG styling, Base Blue, light and dark.

## Two modes

- **Preview** (the default): every screen runs on a simulated market in the browser (`src/lib/preview`), with a scenario switcher for reviewing states. Nothing touches a chain.
- **Live**: the memefun API (`apps/memefun-backend`) and the chain (`src/lib/live`). It switches on when the build has an API URL and contract addresses for its chain. `NEXT_PUBLIC_MEMEFUN_PREVIEW=1` forces preview.

Both implement the same `Market` interface (`src/lib/market/Market.ts`), so screens never know which one they have.

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_MEMEFUN_API_URL` | the memefun API, e.g. `https://memefun-api-production.up.railway.app` |
| `NEXT_PUBLIC_MEMEFUN_CHAIN_ID` | `8453` Base (default), `84532` Base Sepolia, `31337` a local base-anvil |
| `NEXT_PUBLIC_ALCHEMY_API_KEY` | RPC for balances and transactions (Base and Base Sepolia URLs are derived from it) |
| `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | wallet connection; without Privy the app uses a demo wallet |
| `NEXT_PUBLIC_APP_URL` | absolute URL for link previews |

## How live mode works

- **Contract addresses are part of the build** (`src/lib/contracts/deployments.ts`, written by `pnpm deployments` from `packages/memefun-contracts/deployments`). The app checks that the API indexes the same contracts and sends nothing if it does not. Only a local chain takes its addresses from the API.
- **Data**: `LiveMarket` answers every read from a cache, refetches what a screen is showing on its own interval, and takes trades and launches live from the API's event stream. Balances come from the chain.
- **Quotes are exact.** `GET /v1/coins/:address/pool` gives the pool's slot0 and every position; `src/core/uniswap/swap.ts` runs Uniswap v4's swap loop over them. 544 swaps replayed on a real PoolManager match to the unit (`packages/memefun-contracts/test/unit/SwapVectors.t.sol`), and the backend e2e checks the API's quotes against the router.
- **Transactions** (`src/lib/live/tx.ts`) are simulated before the wallet sees them, carry the builder code, approve exactly the amount (or use a permit: one signature and one transaction), and turn every revert into a plain sentence (`txErrors.ts`).
- **Stock pairs** close for visitors from the US and its territories: the middleware stores Cloudflare's country in a cookie (`src/lib/geo.ts`).

## Scripts

```bash
pnpm dev                 # http://localhost:3100 (preview unless the live variables are set)
pnpm typecheck && pnpm lint && pnpm test
pnpm test:local          # the real transaction code against a local chain (run `pnpm dev:chain` in apps/memefun-backend first)
pnpm vectors             # regenerate the golden vectors the contracts replay
pnpm abis                # copy contract ABIs from the Foundry build
pnpm deployments         # copy public deployment addresses into the build
```

Live mode against the local stack: `pnpm dev:chain` and `pnpm dev` in `apps/memefun-backend`, then here `NEXT_PUBLIC_MEMEFUN_API_URL=http://localhost:42069 NEXT_PUBLIC_MEMEFUN_CHAIN_ID=31337 pnpm dev`.

## Deploying

- **Testnet (Base Sepolia):** the Railway service `memefun-web` in the `memefun-testnet` project builds this folder from `main` (`pnpm build`, then `next start`) at https://memefun-web-production.up.railway.app. Its `NEXT_PUBLIC_*` variables live on the service. Railway sends no visitor country, so the stock-pair geofence is open there; that only matters once real stocks are listed.
- **Cloudflare (later, mainnet on memefun.dustswap.wtf):** `.github/workflows/deploy-memefun.yml` builds the OpenNext worker. It stays off until the repository variable `MEMEFUN_TESTNET_DEPLOY` is `on`, and it needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, which the repository does not have yet.

Never deploy from a laptop: a local `.env.local` would end up in the bundle.
