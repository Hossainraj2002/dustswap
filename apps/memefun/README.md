# memefun app

The memefun web app for the deployed Base mainnet contracts (Next.js 15, hosted on Railway with an optional Cloudflare Workers build through OpenNext). Apple HIG styling, Base Blue, light and dark.

## Two modes

- **Live**: the memefun API (`apps/memefun-backend`) and the deployed contracts (`src/lib/live`). It switches on when the build has an API URL and contract addresses for its chain. The mainnet chain is Base, `8453`, and live transactions use real funds.
- **Preview**: screens run on a simulated market in the browser (`src/lib/preview`), with a scenario switcher for reviewing states. Launches and transactions are simulated. It is used when live configuration is absent, or when `NEXT_PUBLIC_MEMEFUN_PREVIEW=1` forces it.

Both implement the same `Market` interface (`src/lib/market/Market.ts`), so screens never know which one they have.

The Base mainnet deployment is recorded in `src/lib/contracts/deployments.ts` at block `52231158`. Automated code review has been performed. A professional independent audit has not been completed; automated review is not an independent audit report.

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

## Builder attribution

MemeFun uses DustSwap's registered Base Builder Code `bc_tpolfjho`, verified against the public `app.dustswap.wtf` wallet bundle. `src/lib/wallet/builderCode.ts` generates the ERC-8021 suffix with `ox`; mismatched `NEXT_PUBLIC_BUILDER_CODE` or `NEXT_PUBLIC_BASE_BUILDER_CODE` build variables are rejected. Both wallet configs use required attribution. The connected-wallet adapter also configures its actual Viem sender because the installed Wagmi connector client does not inherit the config default.

Every app contract submission always supplies that suffix: ERC20 approvals, buys and sells (including permit routes), single/multi-pair and tweet launches, creator/holder/referral/author claims, author wallet verification, treasury reward withdrawals, creator fee reductions and control transfers, test faucets, and owner setters. The transaction override and client default append one suffix, not two. Offchain wallet messages, SIWE and EIP-712/permit signatures are not transactions and must not be modified.

MemeFun checks the connected wallet's capabilities before submission. Wallets supporting `dataSuffix` submit the simulated action as one EIP-5792 call with required attribution, then resolve its receipt without retrying an uncertain batch as a direct transaction. Legacy providers may use direct attributed writes only when their address has no contract/delegation code. Unsupported smart wallets fail before the wallet transaction prompt. Any batch through the attributed client or paymaster capability helper also requires `dataSuffix`. For smart wallets, the wallet appends attribution to the outer transaction or user operation. Internal contract calls are part of that transaction; they are not separately signed transactions. No new contract deployment is needed for the attribution suffix.

Verify a real Base transaction by decoding its input with `Attribution.fromData` and checking for `bc_tpolfjho`, or check the resulting user operation when using a smart wallet. Base.dev indexing/rewards and third-party wallet behavior still require a real-network acceptance check. Preview actions are simulated and create no onchain attribution. See [Base's app integration guide](https://docs.base.org/specifications/builder-codes/for-app-developers) and [wallet integration guide](https://docs.base.org/specifications/builder-codes/for-wallet-developers). Privy's separate suffix plugin is intentionally not used: its [current guide](https://docs.privy.io/recipes/evm/base-builder-codes) does not support the `@privy-io/wagmi` adapter.

## Pair and fee controls

The trade page shows the current trading fee beside the mode badge, including launch-protection decay and later fee reductions. Creator and community earnings remain visible; the redundant fee accordion and platform split bars are omitted. The entered trade's quote still shows its actual trading fee and minimum received.

Slippage starts on Auto, a bounded local estimate rather than an execution oracle. It uses the selected pool's liquidity and actual recent trade prices. New pools (under ten minutes), liquidity below $50K, or insufficient/stale price history use 5%. Mature calm pools use a 3% floor at $50K or a 1% floor at $250K. Twice the largest observed price move in the last minute, plus 0.5%, can raise that floor; the result rounds up to 0.25% and never exceeds 5%. Deterministic quote price impact is not added again as slippage. Manual presets are 1%, 3%, 5% and 10%; custom percentages accept 0.01%–50% with two decimal places. Invalid edits disable submission rather than keeping a prior value.

Live quotes expose exact raw output. The trade panel freezes the resolved tolerance and raw minimum when submitted, and the adapter never lowers that floor on a refreshed quote. A refreshed output below the displayed minimum fails before the wallet opens. Controls and the pool selector stay locked while a trade is pending. Tiny trades whose UI minimum rounds to zero are blocked.

Design references: [Uniswap Auto/Custom](https://support.uniswap.org/hc/en-us/articles/8643879653261-How-to-change-slippage-on-the-Uniswap-Web-app), [Flaunch's 5% SDK examples](https://github.com/flayerlabs/flaunch-sdk#buying-a-flaunch-coin), and [Jupiter's execution estimator](https://developers.jup.ag/docs/swap/advanced/slippage). These support bounded defaults and explicit minimums; MemeFun's thresholds are its own heuristic, not Jupiter RTSE or a guarantee of execution.

A token may launch with one pair or up to five distinct listed pair assets. Multi-pair launching creates one token, splits its supply equally between permanently locked pools, and keeps one opening market cap. The optional first buy targets the pair selected in the first-buy step. Trading uses an explicit market selection; a selected pair's reserves and earnings stay in that pair's currency. Discovery aggregates USD values across markets rather than adding different quote amounts.

Fee modes and splits are fixed at launch. Creators can lower the shared fee across every pair and transfer creator control through proposal and acceptance by the receiving wallet. A fee claim's payout address is independent of that role transfer. Transferring creator control also transfers unclaimed creator earnings; it does not change the destination mode or take module rewards.

The multi-pair contract ABI requires matching deployed contracts and backend data. Live mode submits these actions to the configured deployment. Preview mode remains available for simulation and does not deploy contracts or send real funds.

## Launch by tweet

`/create/tweet` imports a public X post, selects its own photos or a generated text image, and suggests editable names and tickers without an AI service. The existing one-to-five-pair launch flow remains available. Tweet launches fix Creator mode and reserve 20%–100% of creator earnings for the original numeric X author ID, defaulting to 50%, after platform fees. The split is immutable.

Authors may verify X, permanently bind an earning wallet and claim unpaid fees at any time. For the first 180 days after launch, treasury cannot withdraw author reserves. After that, the configured DustSwap treasury can also withdraw the same unpaid balance, even if the author verified or claimed earlier. New author fees keep accruing; every withdrawal reduces the balance available to both parties. Launcher fee reductions and transfers do not transfer the author identity or wallet binding. `/rewards/author` handles X verification, wallet binding and claims. This condition is visible once in the reward terms on each relevant screen.

Preview post imports are real server reads through `/api/tweets/import`; launches, X sign-in and payouts remain explicitly simulated. Configure the web server's `GETX_API_KEY` and optional `GETX_TWEET_DAILY_LIMIT` (default 100) to try imports. Never put the key in a `NEXT_PUBLIC_*` variable. The web preview cap is per process; replicas or restarts need a shared gateway for a fleet-wide spending limit. The live backend uses persistent shared quotas and a cache, and requires GetX, X OAuth and the matching on-chain attestor configuration before tweet launches are enabled. See the backend README for activation requirements.

The OAuth callback returns a one-time completion credential in the app URL fragment. The live browser removes it from history, keeps it only in memory, and completes verification with the current wallet's SIWE session before loading the linked identity. Read hooks never automatically open wallet sign-in prompts. Importing a post does not imply its author's endorsement.

## Branding

The supplied F–M cube artwork is kept in `assets/branding/memefun-logo-source.png`. Run `pnpm brand:assets` to regenerate the sidebar image, favicon, installed-app and wallet icons, and the brand mark in the share card. The artwork retains its original background and colors.

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

- **Mainnet frontend:** the Railway service `memefun-web` serves https://memefun.dustswap.wtf through a DNS-only Cloudflare CNAME. It builds this folder (`pnpm build`) and runs `pnpm exec next start --hostname 0.0.0.0 --port $PORT`. Its `NEXT_PUBLIC_*` variables live on the service. Mainnet builds use chain `8453`, the matching API and committed deployment addresses, with `NEXT_PUBLIC_MEMEFUN_PREVIEW` unset or `0`. Mainnet stock selection requires a verified allowed visitor country; missing country information keeps it disabled.
- **Optional Cloudflare Workers deployment:** `.github/workflows/deploy-memefun.yml` builds the OpenNext worker. It stays off until the repository variable `MEMEFUN_TESTNET_DEPLOY` is `on`, and it needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. The current Railway deployment does not require this workflow.

Production builds must use the service's reviewed variables. If uploading local source, stage only source files and required assets in an isolated directory, excluding `.env*`, local deployment records, dependencies and build output; a laptop's `.env.local` must never enter the bundle.

## Pair logos and stock identity

The launch picker renders address-matched pair images in both the catalog and selected pools. ETH and Base USDC use the original Ethereum and Circle brand assets. Live Base stock rows come from Coinbase's current tokenized-stock inventory; registry-only stock entries are excluded from the picker, and issuer names, symbols and images survive registry merges. Registry prices, geographic restrictions, issuer pauses and launch eligibility still govern selection. Preview and test stock fixtures remain simulated.

Every stock exposed in the official inventory on October 8, 2026 has a bundled authentic logo fallback under `public/pair-icons/stocks`. Records without issuer images use the companies' own published icons. `public/pair-icons/SOURCES.json` records each address, original image URL and file. Meme-token fallbacks and their address-matched provider provenance are recorded in `public/pair-icons/TOKEN-SOURCES.json`. The local manifests supply images only: they never add an asset to the current inventory or enable a pair. New provider images take priority, with the bundled asset used if the remote image fails or no image is supplied. Missing imagery is explicitly labeled unavailable instead of borrowing a ticker's logo.

The backend also retrieves logos for registry crypto assets omitted by o1 and extracts address-matched Base imagery independently of pool price or liquidity. These reads never make a discovery price executable or change registry eligibility. Deploy both the frontend and backend to enable this path on the live site.
