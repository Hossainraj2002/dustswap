# memefun backend

The backend for [memefun.dustswap.wtf](https://memefun.dustswap.wtf): it turns the memefun contracts' events into the exact data the app renders, stores coin images and metadata, and runs the keepers that make buybacks, liquidity floors, stock prices and holder rewards happen.

It is its own service with its own Postgres. It never touches the DustSwap API (`apps/api`); a few patterns (SIWE sign-in, session tokens, origin allowlist) are copied from it, not imported.

## Architecture

```
apps/memefun-backend   Ponder 0.17.12 + Hono, Node 22, one Postgres
  indexer  ponder start        chain events -> tables (src/*.ts, ponder.schema.ts)
  api      ponder serve / dev  read API typed as the app's own data, SSE, share cards, writes, admin
  keeper   tsx keeper/main.ts  buybacks, floors, stock prices, 12-hour holder epochs, metadata
Postgres   Ponder's schema (one per deployment) + memefun_app (our migrations/)
Media      MediaStore: local files (dev, tests) | Pinata IPFS pin + R2 mirror (production)
Chain      MEMEFUN_CHAIN = local (base-anvil 31337) | base-sepolia | base
           addresses from deployments/<chainId>.json
```

- **Indexer.** Every coin is a B20 discovered from `MemeFunFactory.Launched`; its `Transfer` events drive balances and holder counts. The hook's `Trade` event carries the post-swap price, so no PoolManager events are indexed. FeeVault emits no event for credits, so fee ledgers are derived from each `Trade` with the same split the vault applies (`shared/core/fees.ts`, pinned to the contracts by golden vectors).
- **API.** An in-memory market snapshot is rebuilt every 2 seconds from the index: every coin is re-priced live, rolling windows (24h volume, changes, sparkline, momentum) are recomputed only for coins traded in the last day, and holder stats only where transfers happened. Requests read the latest complete snapshot, so the database sees one set of queries per refresh however many requests arrive.
- **Keeper.** Each job takes a Postgres advisory lock, so any number of instances can run and only one acts. Every transaction is simulated first (in the next block's context) and logged to `memefun_app.keeper_run`.

## Quick start (local, nothing in the cloud)

Prerequisites: Node 22, pnpm 9, Docker (on Windows, inside WSL Ubuntu-24.04), and Base's Foundry build in `~/.base-foundry/bin` (base-anvil and base-forge, needed for the B20 precompiles).

```bash
pnpm install
cp .env.example .env.local      # then fill SIWE_SESSION_SECRET and ADMIN_TOKEN (32+ random chars)
pnpm dev:db                     # Postgres in Docker on 127.0.0.1:54329 (keeps WSL awake)
pnpm dev:chain                  # base-anvil :8545, deploy memefun, seed six coins over 2h of chain time
pnpm migrate                    # memefun_app schema (the API and keeper also migrate on start)
pnpm dev                        # indexer + API on http://localhost:42069
pnpm keeper                     # all keeper jobs; or `pnpm keeper --once`, `pnpm keeper --job epochs`
pnpm verify-index               # compares every indexed number with the chain right now
```

`pnpm dev:chain` always starts a fresh chain, and `ponder dev` re-indexes from scratch on every start, so the two never disagree. On the local chain the keeper uses anvil's public dev keys (accounts 0, 8 and 9) when no key is configured; on any other chain keys are required.

## Layout

| Path | What lives there |
|---|---|
| `ponder.config.ts`, `ponder.schema.ts` | Chain, contracts, factory pattern, tables |
| `src/` | Indexing handlers ONLY. Ponder executes every file in `src/` except `src/api/`; `src/_apply.ts` is shared handler code |
| `src/api/index.ts` | API entry: builds the app from `api/` |
| `api/` | Read routes, snapshot, SSE, share cards, media, sign-in, writes, admin |
| `keeper/` | Keeper context, jobs, scheduler |
| `lib/` | Pure logic (tested): price math, trade effects, derivations, rewards, media pipeline, chain and env |
| `shared/` | Copies of the app's core math, data types and ABIs. Do not edit: `pnpm sync-shared` (a test fails if they drift) |
| `migrations/` | memefun_app SQL, append-only, checksummed |
| `scripts/` | dev-db, dev-chain, seed, migrate, sync-shared, verify-index |
| `test/unit`, `test/e2e` | Unit tests (no chain, no DB) and the full-stack suite |

## API

All JSON, numbers as the app's types (`shared/market-types.ts`). Reads are public, cached for 1 to 10 seconds with ETags. Writes must come from an allowed origin.

| Method and path | Returns |
|---|---|
| `GET /v1/coins?sort=trending\|new\|top\|movers&pair=&mode=&age=1h\|6h\|24h\|7d&q=&limit=&cursor=` | `{ coins: Coin[], nextCursor, total, asOf }` (hidden coins never listed) |
| `GET /v1/coins/:address` | `{ coin }` (hidden coins carry `hidden: true`) |
| `GET /v1/coins/:address/trades?limit=&before=` | `{ trades: Trade[] (+kind), nextCursor }` |
| `GET /v1/coins/:address/candles?interval=60\|300\|900\|3600\|14400\|86400&metric=price\|mcap` | `{ candles: Candle[] }`, gap-free, up to 320 |
| `GET /v1/coins/:address/holders?viewer=&limit=` | `{ holders: Holder[] }` with pool, burn, creator and you labels |
| `GET /v1/coins/:address/comments` | `{ comments: Comment[] }` |
| `GET /v1/coins/:address/balance/:owner` | `{ balance, raw }` |
| `GET /v1/activity?limit=` | `{ items: ActivityItem[] }`: trades, launches, burns, floors, payouts, milestones |
| `GET /v1/creators/top`, `GET /v1/profiles/:address` | `CreatorProfile`s, a wallet's trades |
| `GET /v1/positions/:address` | `{ positions: Position[] }` (average-cost P&L) |
| `GET /v1/claimables/:address` | creator fees, referral fees (per pair asset, so `coin` is the pair asset), holder rewards with `index`, `amountRaw`, `proof`, `claimableAt`, `expiresAt` |
| `GET /v1/launch-settings` | live `LaunchSettings` read from MemeFunConfig, plus listed pairs |
| `GET /v1/moderation`, `/v1/search?q=`, `/v1/stats`, `/v1/health` | featured coins and banner, search, totals, snapshot health |
| `GET /v1/stream?coin=` | Server-Sent Events: `trade`, `activity`, `ping` |
| `GET /og/{coin,launch}/:address.png`, `/og/milestone/:address/:level.png`, `/og/profile/:address.png` | 1200 x 630 share cards |
| `GET /media/:cid` | stored media, immutable |
| `POST /v1/auth/nonce`, `POST /v1/auth/verify` | SIWE sign-in (nonces in Postgres, single use), 24h session token |
| `POST /v1/media/image` | PNG, JPEG, WebP or GIF (first frame), under 4 MB; re-encoded to a 512 px WebP; SVG refused |
| `POST /v1/media/metadata` | validated like the launch form; the image must have come through `/v1/media/image`; returns `contractURI` |
| `POST /v1/coins/:address/comments` | signed in; 280 characters; burst, hourly and duplicate limits |
| `POST /v1/reports` | coin or comment, reason, details |
| `/v1/admin/*` (`x-admin-token`) | overview, hide or feature coins, banner, report queue, hide comments, keeper runs, settings history |

Ponder adds `/health`, `/ready` (503 until historical indexing is done), `/status` and `/metrics`.

### What the numbers mean

- A trade's `quoteAmount` is what the trader paid (buy, fee included) or received (sell, fee taken). Volume sums those.
- Market cap is price times every coin not at dEaD; FDV is price times the whole supply. Liquidity is the pool's quote plus the value of the coins still in it.
- Live numbers use the pair asset's current USD price; candles, volume and ATH keep the USD value they had when they happened.
- Changes compare with the last 1-minute close before 5 minutes, 1 hour and 24 hours ago (the opening price when the coin is younger). Momentum is the app's trending score: last-hour volume, scaled by the hour's change (capped at -60% and +300%), plus 40 per trade in the last 15 minutes, boosted for coins under 6 hours old.
- Snipers are wallets other than the creator that bought inside launch protection; same-block buys count wallets that shared a block with another buyer in the first minute.

## Keeper

| Job | Every | Does |
|---|---|---|
| `metadata` | 15 s | Resolves each new coin's contractURI (IPFS, https, or data:), keeps only validated fields, re-encodes the image into our store. Retries with backoff |
| `buyback` | 60 s | Burn-mode coins with at least `BUYBACK_MIN_USD_CENTS` of fees and the 10-minute cooldown passed: `executeBuyback`. `PricePumped` means a same-block pump; it retries next round |
| `floor` | 5 min | Floor-mode coins over `FLOOR_MIN_USD_CENTS`, hourly cooldown: `addFloor` |
| `stock_prices` | 10 min | MANUAL quotes: moves the on-chain price toward the source NAV when it moved 0.5% or is 12 hours old, at most 20% per update; a larger gap logs `price.alert` for the owner |
| `epochs` | 60 s | After each 00:00 or 12:00 UTC boundary (chain time) and once the index has reached it: time-weighted balances per holder-mode coin, pro-rata split of the pot (floor division, dust under $0.01 dropped, remainder stays in the pot), one Merkle tree over every coin, leaves and proofs stored, the full leaf set published to IPFS, then `publishEpoch`. Resumes cleanly after a crash |

**Keys.** One hot wallet per role, so a leaked key is bounded by its role on chain: `KEEPER_PRIVATE_KEY` only triggers buybacks and floors (anyone may), `PRICE_KEEPER_PRIVATE_KEY` moves a stock price at most 20% per update, `REWARDS_PUBLISHER_PRIVATE_KEY` publishes epochs the owner can veto for 12 hours, and can never pay out more than a coin earned. Fund them with a little ETH for gas only. `KEEPER_DRY_RUN=true` simulates and sends nothing.

**Anyone can check an epoch.** The leaf document at the epoch's `leaves_uri` (`memefun_app.reward_epoch`) is the full tree dump; `StandardMerkleTree.load(doc.tree).root` must equal `HolderRewardDistributor.epochs(n).root`, and the weights can be recomputed from public Transfer events.

## Environment

See `.env.example`. The essentials:

| Variable | Used by | Notes |
|---|---|---|
| `MEMEFUN_CHAIN`, `MEMEFUN_RPC_URLS` | all | Base mainnet refuses the public RPC; use the paid endpoints |
| `DATABASE_URL`, `DATABASE_SCHEMA` | all | `DATABASE_SCHEMA` is required for `ponder start` and `ponder serve`, and is the schema the API and keeper read |
| `PUBLIC_API_URL`, `ALLOWED_ORIGINS` | api | `ALLOWED_ORIGINS` also defines the accepted SIWE domains; required off the local chain |
| `SIWE_SESSION_SECRET`, `ADMIN_TOKEN` | api | 32+ random characters each |
| `MEDIA_STORE`, `MEDIA_LOCAL_DIR`, `PINATA_*`, `R2_*` | api, keeper | `local` or `pinata` |
| `KEEPER_PRIVATE_KEY`, `PRICE_KEEPER_PRIVATE_KEY`, `REWARDS_PUBLISHER_PRIVATE_KEY` | keeper | local chain falls back to anvil's dev keys |
| `BUYBACK_MIN_USD_CENTS`, `FLOOR_MIN_USD_CENTS`, `KEEPER_DRY_RUN` | keeper | thresholds default to $5 and $10 ($0.50 locally) |
| `STOCK_PRICE_URL`, `STOCK_PRICE_JSON_PATH` | keeper | NAV source; `{symbol}` and `{address}` placeholders |

## Testing

```bash
pnpm typecheck && pnpm lint && pnpm test    # 104 unit tests: math, effects, derivations, rewards, media, API helpers, keeper
pnpm e2e                                    # the whole stack, isolated (needs `pnpm dev:db`)
pnpm verify-index                           # the running dev index against the dev chain
```

`pnpm e2e` builds its own world: base-anvil on :8546 deployed and seeded, a fresh `memefun_e2e` database, `ponder start` serving on :42070, a temporary media directory. It then checks, in order:

1. the index equals the chain (every balance, price, fee ledger, module total, candle, and per-asset conservation),
2. the API's prices, holders, paged trades and candles match the chain,
3. the keeper resolves every coin's metadata and image,
4. the keeper's buyback burns coins,
5. a 12-hour epoch is published, its IPFS leaf set rebuilds the on-chain root, and a holder claims on chain with the API's proof,
6. image, metadata, launch, then the indexed coin shows that metadata,
7. sign-in, comments, moderation and reports,
8. the live stream pushes a new trade,
9. after all of it, the index still equals the chain.

## Windows notes

- **Ponder exits silently when stdin is closed** (its shutdown handler attaches readline to stdin on Windows). Scripts that run it in the background must keep stdin open; the e2e setup spawns it with a stdin pipe.
- **WSL stops the distro about a minute after the last wsl.exe session**, taking Docker and Postgres with it. `pnpm dev:db` leaves a detached `wsl -- sleep infinity` keep-alive running; `pnpm dev:db --stop` ends it.
- **`forge script` needs `--offline`**, or it can hang after the run looking up trace signatures online.

## Phase 4 provisioning (not done yet)

1. Deploy the contracts to Base Sepolia with `script/Deploy.s.sol` from an encrypted keystore, then `pnpm sync-shared` to copy `deployments/84532.json` here.
2. Railway: a new project (not `mellow-wisdom`) with Postgres and three services from this folder:
   - indexer: `ponder start --schema $RAILWAY_DEPLOYMENT_ID --views-schema memefun`
   - api: `ponder serve --schema memefun` (health check `/ready`)
   - keeper: `pnpm keeper`
3. Cloudflare R2 bucket with a custom domain for media; Pinata account (JWT and dedicated gateway); set `MEDIA_STORE=pinata`.
4. Three keeper wallets, funded with gas only; `MemeFunConfig.setPriceKeeper` and `setRewardsPublisher` from the owner Safe.
5. `ALLOWED_ORIGINS=https://memefun.dustswap.wtf`, fresh `SIWE_SESSION_SECRET` and `ADMIN_TOKEN`, paid RPC URLs.
6. Point the app at the API (PreviewMarket to the live source).

## Known limits and things to confirm in Phase 4

- **Stock NAV source.** The keeper reads a configurable HTTP JSON source; the exact Coinbase tokenized-stock NAV endpoint must be confirmed and set in `STOCK_PRICE_URL` before stock pairs go live.
- **Pinata API.** The adapter uses `pinning/pinFileToIPFS` with CIDv1; confirm against the account's API version when provisioning. A contract test pins what is sent.
- **`eth_call` on `pending`.** Keeper simulations run in the next block's context; confirm the production RPC supports `pending` (Alchemy does on Base).
- **Trade attribution.** Trades through MemeFunRouter name the user; through Uniswap's Universal Router, the transaction sender; through any other router, the router address (add it to `MEMEFUN_EXTRA_ROUTERS`). A first buy is attributed to the creator.
- **Referral claimables** are per pair asset, as FeeVault keeps them; the app shows them per asset, not per coin.
- **Cost basis** is the average cost of the wallet's own trades; coins received by transfer are valued at today's price.
- **Rate limits** for uploads, comments and reports are counted in Postgres (shared by replicas); sign-in burst limits are per process.
