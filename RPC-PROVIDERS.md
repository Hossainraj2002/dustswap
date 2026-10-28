# RPC provider audit — 2026-10-28

Standard chain reads now use public RPCs first. Alchemy URLs and keys remain configured as
fallbacks. Rebuild and deploy the affected apps for these source changes to affect live traffic;
this audit does not measure a production traffic percentage or promise public-provider capacity.

## Active request paths

| Location | Routing |
| --- | --- |
| `apps/api/src/utils/baseRpc.ts` | Base reads rotate among four independent public RPCs; configured providers and Blockscout RPC follow; Alchemy is last. |
| `apps/api/src/utils/chainRpc.ts` | Ethereum, BSC, Arbitrum, Optimism, and Robinhood standard reads use public RPCs first, with chain-specific Alchemy fallback. |
| `apps/api/src/config/swapChains.ts` | Swap reads use the shared public pools on supported chains and ordered public-first viem fallback on the remaining chains. |
| `apps/web/src/config/web3.ts` | Wallet/app reads rotate among public URLs; Alchemy never joins normal rotation. Built-in public defaults remain present even if environment URLs contain only Alchemy. |
| `apps/api/src/routes/dustsweep.ts` | Wallet token discovery uses the existing public Blockscout index first on Base, Arbitrum, Optimism, and Robinhood. Failed or capped public scans can use Alchemy. Prices already try public sources before Alchemy. |
| `apps/api/src/services/pointsEngine.ts` | Standard EntryPoint block/log reads now use the public-first generic pool. Transaction verification continues to use its public receipt pool. |
| `apps/api/src/services/swapRecorder.ts` | Transaction/receipt checks use public-first clients; Base keeps its receipt-specific verification pool. |
| `apps/memefun/src/lib/wallet/rpc.ts` | Public Base/Sepolia RPCs precede configured Alchemy URLs; normal rotation excludes Alchemy. |
| `apps/memefun-backend/lib/chain.ts`, `ponder.config.ts` | Public defaults and ordered fallback for API, keeper, and indexer. Ponder receives a fallback transport because a URL array would balance traffic onto paid providers. Local-chain overrides remain supported. |

## Remaining specialized Alchemy dependencies

- Complete Ethereum and BSC wallet token enumeration still uses `alchemy_getTokenBalances`:
  these chains currently have no alternate indexed balance provider configured. Ordinary
  JSON-RPC can read a known token's balance but cannot list every token a wallet owns. These
  scans can remain unavailable while the Alchemy account is overdue; existing stale-cache/error
  behavior is retained instead of reporting an incomplete known-token scan as complete.
- ERC-4337 receipt resolution uses `eth_getUserOperationReceipt` in points/campaign/swap
  recording. This is a bundler method and generally unavailable on ordinary public RPCs.
  Points also retain their existing EntryPoint event-log recovery on public RPCs.
- `alchemy_getAssetTransfers` remains a best-effort history/recovery source in `questEngine.ts`
  and `pointsEngine.ts`.
- Alchemy's Prices API remains a fallback for tokens public price sources cannot price.
- `src/services/tokenDiscovery.ts` and `tokens/dust/route.ts` contain older Alchemy balance/
  metadata paths. No imports/mounts for them were found in the active API entrypoint/routes.
  The installed `alchemy-sdk` dependency has no source imports. These dormant paths were left
  intact to avoid replacing full enumeration with a partial known-token list.

## Configuration and reliability

- Existing `ALCHEMY_*` / `NEXT_PUBLIC_ALCHEMY_*` keys can be replaced later. Server keys stay
  server-side; existing explicitly public keys are handled by the frontend build as before.
- Legacy `*_RPC_PUBLIC_FALLBACK=0`, `ALCHEMY_*_RPC_DEDICATED_ONLY=first`, and unset/false modes
  no longer promote Alchemy over public nodes. A true dedicated-only setting still excludes
  Alchemy from standard reads while retaining the dedicated enhanced-API lane.
- An Alchemy URL inside a generic `*_RPC_URL(S)` setting is also classified as a fallback.
- Dedicated receipt/API lookups also recognize Alchemy URLs in generic RPC settings, so a
  dedicated-only configuration does not strand smart-wallet receipt resolution.
- Provider/network/capacity/unsupported-method errors allow failover; real contract reverts
  stay authoritative. Browser endpoint timeouts and caller cancellation are covered by tests.
- Public discovery has one overall timeout, including retries and pagination, before trying
  Alchemy. Failed Alchemy discovery gets a separate cooldown per chain. Malformed explorer
  responses cannot become a successful empty wallet.
- Browser Base defaults exclude Nodies because its preflight CORS probe failed; server Base
  defaults may still use it.
- MemeFun wallet/market reads, API, keeper and Ponder indexer all use the public-first pools.
  API, keeper and indexer keep provider ranking disabled. Frontend URL validation and transient
  provider-error handling preserve failover when a configured URL or public node is unusable.

## Verification

Regression coverage exercises healthy public traffic with overdue keys, public failures followed
by Alchemy success, legacy environment settings, endpoint rotation, unsupported methods,
deterministic reverts, cancellation, stalled browser responses, indexer failure, empty wallets,
and capped token scans. Existing Optimism quote/build/record tests also run with these changes.
Whole-package TypeScript checks cover all four affected apps.

The bug recheck also exercises actual installed wagmi/viem transports rather than only mocked
transport constructors. Fixes cover malformed configured URLs, numeric provider error codes,
outer timeouts cutting off the final fallback, signed-transaction rejections getting masked
by a later billing error, and lost custom contract revert data. Ponder retains log range-limit
errors so its adaptive query splitting can work while an Alchemy fallback is overdue. Token
discovery cancels its losing snapshot request and cannot treat a paginated snapshot, repeated
cursor, or malformed Alchemy result as a complete wallet scan.

Read-only live probes checked chain IDs, contract calls, blocks, and recent receipts on the
selected mainnet RPCs. Browser pools additionally use preflight/POST CORS checks. These are
point-in-time availability checks, not a production load test. The existing frontend results
test's stale modal import was repaired in the test harness by rendering portal children during
its receipt-content assertions; no product modal or receipt logic changed.

### Compatibility pass

- Main web app: all 40 tests passed, covering wallet batching and chain selection, RPC failover,
  receipt/refund display, minimum receive, and success content. Its production build passed
  compilation, lint/types, all 32 static pages and trace generation.
- API: all 75 tests passed, including 10 comparisons of the current viem client actions with the
  previous direct HTTP transport. Quote, transaction-building, recording, discovery, and
  smart-wallet receipt tests passed.
- MemeFun after the final public-RPC update: full frontend suite passed 842 tests and full
  backend suite passed 639 tests, including 16 keeper transport regressions. Backend types and
  whole-backend ESLint checks also passed. Its
  production Next build passed, including lint/types and all 15 static pages.
- Actual API helpers completed 95 read-only calls across 11 networks through 18 public hosts,
  with Alchemy and write methods explicitly blocked. Balances, token decimals, transactions,
  receipts, blocks, gas prices and pending nonces were checked.
- Browser checks confirmed the live DustSweep page and the changed local page load, with the
  same sweep form and wallet chooser; the changed local Swap page also rendered its controls.
  Local saved environment settings differ from deployment
  settings (including enabled chains and API origin); these configuration files were not changed.

These checks do not execute a real wallet signature, swap, payout, or production indexer.
The source changes still need deployment before they affect live provider routing. The enhanced
API dependencies listed above continue to need a working provider where no public replacement
is configured.

Provider references: [PublicNode](https://publicnode.com/),
[Base connection guide](https://docs.base.org/get-started/connect-to-base),
[Alchemy Token API](https://www.alchemy.com/docs/reference/token-api-overview).
