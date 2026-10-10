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
- **Keeper.** Each job takes a Postgres advisory lock, so any number of instances can run and only one acts. Chain-mutating jobs run sequentially in each process and lock their configured signer addresses across replicas, allowing testnet roles to share one signer without racing nonces. Metadata jobs remain independent. Every transaction is simulated first (in the next block's context), carries DustSwap's ERC-8021 builder code `bc_tpolfjho`, and is logged to `memefun_app.keeper_run`. Keeper clients and the submission boundary both configure the suffix; Viem appends it once. Any configured builder-code alias must match the canonical code.

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

`pnpm dev:chain` always starts a fresh chain and clears what Ponder cached about earlier local chains (they all share chain id 31337), and `ponder dev` re-indexes from scratch on every start, so the two never disagree. Restart `ponder dev` after each `pnpm dev:chain`. On the local chain the keeper uses anvil's public dev keys (accounts 0, 8 and 9) when no key is configured; on any other chain keys are required.

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
| `GET /v1/coins/:address/pool` | `{ pool }`: slot0 (`sqrtPriceX96`, `tick`), the launch position (`startTick`, `liquidity`) and every floor band, the pool's only liquidity. The app quotes trades from it exactly (`shared/core/pool.ts` `livePool`); the e2e suite checks those quotes against the router's fills |
| `GET /v1/activity?limit=` | `{ items: ActivityItem[] }`: trades, launches, burns, floors, payouts, milestones |
| `GET /v1/creators/top`, `GET /v1/profiles/:address` | `CreatorProfile`s, a wallet's trades |
| `GET /v1/positions/:address` | `{ positions: Position[] }` (average-cost P&L) |
| `GET /v1/claimables/:address` | creator fees, referral fees (per pair asset, so `coin` is the pair asset), holder rewards with `index`, `amountRaw`, `proof`, `claimableAt`, `expiresAt` |
| `GET /v1/launch-settings` | live `LaunchSettings` read from MemeFunConfig, plus listed pairs |
| `GET /v1/moderation`, `/v1/search?q=`, `/v1/stats`, `/v1/health` | featured coins and banner, search, totals, snapshot health |
| `GET /v1/deployment` | the contract addresses this API indexes; the app refuses to send anything if they differ from its own build |
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

The optional platform-token campaign is configured separately. See [Launch reward setup](LAUNCH-REWARDS.md) for funding, activation, eligibility and dedicated signing-key requirements. It is disabled by default and needs no frontend secret.

See `.env.example`. The essentials:

| Variable | Used by | Notes |
|---|---|---|
| `MEMEFUN_CHAIN`, `MEMEFUN_RPC_URLS` | all | Base mainnet refuses the public RPC; use the paid endpoints |
| `DATABASE_URL`, `DATABASE_SCHEMA` | all | `DATABASE_SCHEMA` is required for `ponder start` and `ponder serve`, and is the schema the API and keeper read |
| `PUBLIC_API_URL`, `ALLOWED_ORIGINS` | api | `ALLOWED_ORIGINS` also defines the accepted SIWE domains; required off the local chain |
| `SIWE_SESSION_SECRET`, `ADMIN_TOKEN` | api | 32+ random characters each |
| `MEDIA_STORE`, `MEDIA_LOCAL_DIR` | api, keeper | `local` (files on disk), `bucket` (one S3-compatible bucket shared by API and keeper, served at `/media/<cid>`; the testnet) or `pinata` (Pinata IPFS pin + R2 mirror; mainnet) |
| `BUCKET_ENDPOINT`, `BUCKET_NAME`, `BUCKET_ACCESS_KEY_ID`, `BUCKET_SECRET_ACCESS_KEY`, `BUCKET_REGION` | api, keeper | `bucket` store; on Railway, references to the bucket's own variables |
| `PINATA_JWT`, `PINATA_GATEWAY`, `R2_*` | api, keeper | `pinata` store |
| `KEEPER_PRIVATE_KEY`, `PRICE_KEEPER_PRIVATE_KEY`, `REWARDS_PUBLISHER_PRIVATE_KEY` | keeper | local chain falls back to anvil's dev keys |
| `BUYBACK_MIN_USD_CENTS`, `FLOOR_MIN_USD_CENTS`, `KEEPER_DRY_RUN` | keeper | thresholds default to $5 and $10 ($0.50 locally) |
| `STOCK_PRICE_SOURCE` | keeper | `dev` (a drift around the current price; local chain and testnets only, refused on mainnet), `http`, or `none`. Default: `http` when `STOCK_PRICE_URL` is set, `dev` locally, otherwise `none` |
| `STOCK_PRICE_URL`, `STOCK_PRICE_JSON_PATH` | keeper | the `http` source; `{symbol}` and `{address}` placeholders |

## Testing

```bash
pnpm typecheck && pnpm lint && pnpm test    # 105 unit tests: math, effects, derivations, rewards, media, API helpers, keeper
pnpm e2e                                    # the whole stack, isolated (needs `pnpm dev:db`)
pnpm verify-index                           # the running dev index against the dev chain
```

`pnpm e2e` builds its own world: base-anvil on :8546 deployed and seeded, a fresh `memefun_e2e` database, `ponder start` serving on :42070, a temporary media directory. It then checks, in order:

1. the index equals the chain (every balance, price, fee ledger, module total, candle, and per-asset conservation),
2. the API's prices, holders, paged trades and candles match the chain,
3. the pool endpoint quotes exactly what the router fills, for buys and sells on every pair,
4. the keeper resolves every coin's metadata and image,
5. the keeper's buyback burns coins,
6. a 12-hour epoch is published, its IPFS leaf set rebuilds the on-chain root, and a holder claims on chain with the API's proof,
7. image, metadata, launch, then the indexed coin shows that metadata,
8. sign-in, comments, moderation and reports,
9. the live stream pushes a new trade,
10. after all of it, the index still equals the chain,
11. one coin launches against ETH, USDC and an 8-decimal stock, each pool's quotes and trades stay separate, creator fees transfer together, the fee falls across all pools, and a USDC payout leaves the other fee balances unchanged.

## Windows notes

- **Ponder exits silently when stdin is closed** (its shutdown handler attaches readline to stdin on Windows). Scripts that run it in the background must keep stdin open; the e2e setup spawns it with a stdin pipe.
- **WSL stops the distro about a minute after the last wsl.exe session**, taking Docker and Postgres with it. `pnpm dev:db` leaves a detached `wsl -- sleep infinity` keep-alive running; `pnpm dev:db --stop` ends it.
- **`forge script` needs `--offline`**, or it can hang after the run looking up trace signatures online.

## Base Sepolia (testnet) on Railway

Railway project `memefun-testnet` (not DustSwap's `mellow-wisdom`): Postgres, a storage bucket and three services built from `main`, each watching only its own folder:

| Service | Root | Start command | Notes |
|---|---|---|---|
| `memefun-api` | `/apps/memefun-backend` | `pnpm exec ponder start --schema $RAILWAY_DEPLOYMENT_ID --views-schema memefun --port $PORT` | indexer and API in one process; each deploy indexes into a fresh schema and the `memefun` views switch over once it is ready. Health check `/ready` (300 s). `https://memefun-api-production.up.railway.app` |
| `memefun-keeper` | `/apps/memefun-backend` | `pnpm keeper` | no domain |
| `memefun-web` | `/apps/memefun` | `pnpm exec next start --hostname 0.0.0.0 --port $PORT` | the public preview at `https://memefun.dustswap.wtf`, built for chain 84532 with preview forced |

Variables already set: `MEMEFUN_CHAIN=base-sepolia`, `MEMEFUN_RPC_URLS` (public Base Sepolia endpoints for now; a paid URL can replace them), `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `DATABASE_SCHEMA=memefun`, `PUBLIC_API_URL`, `ALLOWED_ORIGINS` (the app), `MEDIA_STORE=bucket` with `BUCKET_*` referencing the `memefun-media` bucket, `STOCK_PRICE_SOURCE=dev` on the keeper (the test stock has no real price).

`SIWE_SESSION_SECRET` and `ADMIN_TOKEN` are configured on `memefun-api`, and its allowed origins include the custom domain. The keeper remains in dry-run mode. Live operation still needs matching public deployment records, funded keeper/price-keeper/rewards-publisher signing keys, and the web wallet integration (`NEXT_PUBLIC_PRIVY_APP_ID`, with the site allowed in Privy). Keep signing keys in the provider's secret settings.

Order of work:

1. Deploy the contracts from an encrypted keystore (`packages/memefun-contracts` README, "Base Sepolia"), then `pnpm sync-shared` here and `pnpm deployments` in `apps/memefun`, and commit the records.
2. Connect the three services to the repository (branch `main`); they build and deploy.
3. Check `/ready`, `/v1/health` and `pnpm verify-index` against the Railway database.

Mainnet (Phase 5) uses the same layout with a Safe as owner, Pinata + R2 media, a paid RPC and Coinbase's tokenized stocks priced by their Chainlink feeds (no keeper price source). The custom domain currently serves the testnet-configured preview.

## Known limits

### Multi-pair indexing and rewards

A coin has one token identity and holder set, with up to five markets identified by their pool IDs. Pool state, quote-denominated fees, charts and module activity are scoped to a market. The primary market preserves the single-pair API behavior; explicit market queries select another pool. Coin discovery combines USD volume and liquidity and uses a pool-token-reserve-weighted USD price. It never adds native ETH, stablecoin and stock token amounts together.

New multi-market reward epochs bind each leaf to its pool ID and use a separate, versioned leaf format. A root contains only one format. Legacy epochs retain the original coin-bound leaves; callers must use the claim function for the epoch's format. The keeper reserves and distributes each market's quote asset separately, reusing the token's holder history without duplicating holders.

Deploy the updated contracts and regenerate their ABIs before enabling live multi-pair launching. Ponder should reindex from the deployment block into a fresh deployment schema; old single-pair tables must not be treated as multi-market data.

### Tweet authors and fee reserves

`POST /v1/tweets/import` accepts a public X post URL and returns verified numeric post/author IDs, text, safe X media URLs and editable name/ticker suggestions. It calls the fixed GetXAPI detail endpoint with `GETX_API_KEY`; public imports share a database-backed cache and provider/request quotas across replicas. Client-provided handles never determine an author fee recipient.

`GETX_TWEET_DAILY_LIMIT` defaults to 100 paid detail reads per UTC day across all backend replicas and restarts; use an integer from 0 to 10,000. Zero disables paid reads. The budget is reserved before fetching, including failed calls, and one-hour cache hits cost no provider read. At GetXAPI's [published $0.001 detail-read rate](https://docs.getxapi.com/docs), the default is a nominal maximum of $0.10 per day for this backend feature; other applications using the same provider key have their own budgets.

Official X author verification has a separate shared UTC-day budget, `X_AUTHOR_VERIFY_DAILY_LIMIT`, defaulting to 10 attempts (integer 0–10,000). Zero disables new OAuth flows and live tweet-launch support. A valid, atomically consumed state reserves a potential `users/me` read before either official HTTP call; failed flows count conservatively and state replay cannot spend again. At X's [published general User Read rate of $0.010/resource](https://docs.x.com/x-api/getting-started/pricing), 10 attempts estimate at most $0.10/day of user reads for this feature. Actual billing, deduplication and current endpoint prices are authoritative in the X Developer Console; this estimate does not cover other consumers of the app credentials.

`POST /v1/tweets/attestation` requires a memefun SIWE bearer token and binds the real post and author, the immutable 20%–100% author share, launcher, launch salt, chain and factory in a five-minute EIP-712 signature. `TWEET_ATTESTOR_PRIVATE_KEY` must match the deployment's `MemeFunConfig.tweetAttestor()`. Live imports advertise author fee support only when both the signer and X OAuth verification are configured. Missing either blocks attestation with 503; preview imports never imply that live author fees are enabled.

Authors sign in with their wallet, start `POST /v1/author/connect`, and verify X using official OAuth PKCE with only `users.read` and `tweet.read`. Configure `X_CLIENT_ID`, optional confidential-client `X_CLIENT_SECRET`, and the exact `X_REDIRECT_URI` (`/v1/author/callback`) in the X developer app. OAuth state is consumed atomically in Postgres. The callback does not link the identity: it returns a fresh five-minute completion token in the allowlisted app URL's `authorCompletion` fragment. The browser removes the fragment and sends `POST /v1/author/complete {token}` with its SIWE session. Only the original wallet can atomically consume it; forwarding an OAuth link cannot link the victim's X account. Access/refresh tokens are discarded; only the official numeric X ID and profile are retained after completion. `GET /v1/author/me` returns that verified account. A fresh verification (within 15 minutes) permits `POST /v1/author/verification {coin}`, which signs the caller wallet and coin's immutable author ID. The wallet submits `verifyAuthor` on chain once, then claims each quote asset directly with `claimAuthorFor`.

Author fees always accrue into one pending balance for each market/currency. Authors can verify their X identity, bind their wallet and claim unpaid fees at any time. At launch plus 180 days, the configured treasury also gains the right to withdraw that same unpaid balance, regardless of prior author verification or claims. Only the treasury can initiate its withdrawal, and its payout is fixed to that treasury address. Either withdrawal reduces the balance for both parties; new fees continue accruing afterward. There is no author-expiry cutoff or automatic redirect of future allocations. Attribution arrives before pool registration and first buys; the indexer buffers it independently and divides only the existing creator allocation, preserving platform/referral splits. `GET /v1/coins/:address/author` separates verified identity from `treasuryUnlockAt` and `treasuryUnlocked`. The legacy `verifyBy` timestamp aliases treasury unlock time; it is not a verification deadline. `reclaimed` records historical treasury withdrawals without forfeiting future author fees. `/v1/claimables/:wallet` includes positive author rewards for the bound wallet, before or after treasury unlock.

- **Stock prices.** On mainnet each Coinbase tokenized stock has a Chainlink feed, so it is listed as a CHAINLINK quote and needs no keeper price. MANUAL quotes (the testnet's test stock) follow `STOCK_PRICE_SOURCE`.
- **Pinata API.** The adapter uses `pinning/pinFileToIPFS` with CIDv1; confirm against the account's API version when provisioning. A contract test pins what is sent.
- **`eth_call` on `pending`.** Keeper simulations run in the next block's context; confirm the production RPC supports `pending` (Alchemy does on Base).
- **Trade attribution.** Trades through MemeFunRouter name the user; through Uniswap's Universal Router, the transaction sender; through any other router, the router address (add it to `MEMEFUN_EXTRA_ROUTERS`). A first buy is attributed to the creator.
- **Referral claimables** are per pair asset, as FeeVault keeps them; the app shows them per asset, not per coin.
- **Cost basis** is the average cost of the wallet's own trades; coins received by transfer are valued at today's price.
- **Rate limits** for uploads, comments and reports are counted in Postgres (shared by replicas); sign-in burst limits are per process.

### Official platform-token selection

The optional Base mainnet announcement uses public `MEMEFUN_PLATFORM_TOKEN_LAUNCH_AT` (an exact UTC timestamp such as `2026-10-10T09:00:00Z`) and `MEMEFUN_PLATFORM_TOKEN_LAUNCHER` (the wallet that actually calls the factory). Missing or invalid settings leave `GET /v1/platform-token` disabled. The launch time controls the announcement countdown; it does not create an onchain launch restriction or activate the separate funded reward campaign.

The designated wallet signs in through existing SIWE, explicitly selects its official launch in the create flow, and calls `POST /v1/platform-token/prepare {salt,contractURI}` before broadcasting. The API binds a durable intent to the factory's predicted coin and exact metadata URI, rejecting tokens that already exist. Exact retries retain the original intent, including across a long wallet prompt. Preparations that are never launched do not take the official slot.

Public GET polling recovers the selection after the browser closes. It requires a complete indexed block and three Base confirmations, then verifies the actual factory `Launched` event against the canonical transaction receipt and block hash. Three confirmations are **not finalized** and do not change the reward campaign's finalized eligibility gate. Among qualifying prepared creations, block and log order decide the first token. The resulting official pin cannot be replaced. Every five seconds at most, polling revalidates its canonical receipt; disappeared or replaced history hides official status and never assigns another token. Moderation, ticker, name and mutable fee creator do not authorize a selection.

Focused tests: `node node_modules/vitest/vitest.mjs run test/unit/platform-token.test.ts`. The optional real-Postgres suite (`--config vitest.platform-token.config.ts`) accepts only a loopback local test port through `MEMEFUN_PLATFORM_TOKEN_TEST_PORT`, creates its own random database and removes it afterward. It never uses `DATABASE_URL` or operator env files.
