---
title: "DustSweep Technical Specification"
---

# DustSweep Technical Specification

**Product:** DustSweep — the dust-sweeping feature of DustSwap (`/dustsweep`)
**Network:** Base mainnet (chainId 8453) only
**Status of this document:** Drafted from a full code review of the DustSwap repository (frontend, backend API, and smart contracts). Statements are grounded in code. Anything not directly verifiable in the repository is marked **Needs confirmation** or **TODO**.

---

## 1. Overview

DustSweep lets a user convert many small, near-worthless ERC-20 balances ("dust") in their wallet into a single useful output token — ETH, WETH, USDC, or USDT — in as few wallet interactions as possible (ideally one).

At a high level, DustSweep:

- Scans the connected wallet for every non-zero ERC-20 balance on Base.
- Prices and classifies those balances (swappable, hidden, suspicious, unavailable).
- Quotes each selected token against multiple Base DEXes and one aggregator, picking the best route per token.
- Executes all swaps in a single on-chain transaction through a purpose-built, owner-allowlisted sweep router contract.
- Uses Permit2 signatures, EIP-5792 wallet batching, and EIP-7702 delegation awareness to minimize the number of approvals and prompts the user sees.
- Takes a protocol fee from the realized output (hard-capped on-chain at 3%) and delivers the net output to the user.

The system is **non-custodial**: the router contract holds tokens only transiently inside a single transaction, pulls exact amounts only, and resets every approval to zero before the transaction ends.

Three router generations exist in the codebase:

| Generation | Contract | Role today |
|---|---|---|
| V1 | `DustSweepRouter.sol` | Legacy. Uniswap V3 only, max 10 tokens, plain approvals. |
| V2 | `DustSweepPermit2RouterV2.sol` | Previous production router. Permit2 witness + allowance modes, all-or-nothing execution. |
| V3 | `DustSwapSweepRouter.sol` ("DustSweep V3") | Current router. Best-effort execution, per-route refunds, native ETH output, fee bound into the signed witness. |

The active lane is selected by configuration (`DUST_SWEEP_EXECUTION_LANE`, currently `owned_v2`); when `DUST_SWEEP_ROUTER_V3_ADDRESS` is set, the `owned_v2` lane transparently routes through V3 (single-switch design, no V2/V3 runtime fallback).

---

## 2. Problem: Wallet Dust and Fragmented Balances

Active on-chain users accumulate dozens of token balances that are individually too small to act on:

- Leftovers from swaps, LP exits, and partially-sold positions.
- Airdrops and incentive tokens worth a few cents or dollars.
- Spam and scam tokens sent unsolicited.

Each dust balance is individually painful to dispose of: a normal swap flow costs one approval transaction plus one swap transaction per token, the DEX UI may not even list the token, and the gas plus the mental overhead often exceed the token's value. The practical result is wallets with 30–200 stranded balances and no economic way to consolidate them.

A correct dust solution must solve four problems at once:

1. **Discovery** — find everything the wallet actually holds, not just a curated token list.
2. **Safety classification** — separate sellable tokens from spam/honeypots before the user touches them.
3. **Routing** — find liquidity for long-tail tokens across many venues, not just one DEX.
4. **Transaction compression** — collapse N approvals + N swaps into one (or very few) wallet interactions, across wallets with wildly different capabilities.

---

## 3. Product Goal

Deliver a one-click (or near-one-click) "sweep" that:

- Works for up to **50 tokens per sweep** (V2/V3 contract limit `MAX_BATCH_SIZE = 50`; V1 lane is capped at 10).
- Never asks the user for an unlimited or standing token approval to the DustSweep router.
- Never silently strands funds: a failed swap leg is skipped and the input refunded (V3), never lost.
- Always has a working path on any reasonable wallet — wallets with EIP-5792 atomic batching get the premium one-prompt flow; everything else gets a Permit2 signature + one transaction, or exact approvals + one transaction.
- Keeps the protocol fee transparent, capped on-chain (3% max), and — in the Permit2 path — cryptographically bound into what the user signs.

---

## 4. High-Level User Flow

The `/dustsweep` page (`apps/web/src/app/dustsweep/page.tsx`) orchestrates the following flow, with all state managed by the `useDustSweep` hook:

1. **Connect wallet.** Wallet connection is handled by the app-wide wallet stack (Privy + wagmi). On connect, DustSweep runs two detections in parallel:
   - `wallet_getCapabilities` → can this wallet batch atomically right now? (EIP-5792, Section 11)
   - `eth_getCode` on the user's address → is this EOA delegated via EIP-7702, and to whom? (Section 12). Delegation is per-chain, so this read uses an RPC client pinned to Base; the wallet itself is switched to Base when the sweep is executed.
   The results resolve a **route kind**: `batch`, `switch_or_permit2`, or `permit2`.
2. **Balance scan.** The frontend calls `GET /api/dustsweep/tokens?address=…&chainId=8453`. The backend discovers all non-zero ERC-20 balances, prices them, risk-classifies them, and returns `swappable`, `unavailable`, `hidden`, `suspicious`, and `excludedOutputAssets` lists (Section 6). The UI shows progress states ("Finding Base balances…", "Checking prices and sweep routes…"); the scan aborts after 45 seconds.
3. **Token selection.** The user picks tokens from the swappable list (manually, "select all", or auto-mode which selects everything at or below a configurable USD value, default $100). Tokens equal to the chosen output token are excluded automatically. Selection is capped at the route cap (50 in the current lane).
4. **Output token selection.** Defaults: native ETH, USDC, WETH, USDT (in that order; ETH is the default). Native ETH output is represented by the sentinel address `0xEeee…EEeE` and is only supported on V3 (the router unwraps WETH at settlement).
5. **Quote.** The frontend posts the selection to `POST /api/dustsweep/quote`. The backend re-checks live balances, then quotes each token across all venues in parallel and returns per-token routes, per-token `amountOutMin`, an aggregate estimate, fee preview, a 30-minute deadline, and a random Permit2 nonce (Section 7). Tokens that cannot be routed come back in `skippedTokens` with a reason.
6. **Review.** The UI shows the route per token (DEX name), total estimated output, fee, gas estimate, and the wallet-specific execution notice (e.g. "MetaMask approval batching is disabled for safety…"). A price-impact confirmation dialog appears if any route exceeds 5% (500 bps) price impact.
7. **Execute.** The user presses **Sweep**. The frontend calls `POST /api/dustsweep/build-tx`, then executes via the route resolved in step 1 (Sections 11–14). The on-screen stepper is route-aware: `Confirm batch → Done` (batch), `Setup → Sign → Sweep → Done` (Permit2 with first-time approvals), `Sign → Sweep → Done` (Permit2, already set up), or `Approve → Sweep → Done` (standard approvals).
8. **Success / failure.** On success the UI shows a completion summary (tokens swept, output amount, fee, BaseScan link) and posts `POST /api/dustsweep/record-sweep` for quest/points tracking. On failure the error is mapped to a human-readable message; user rejection is shown as "Approval cancelled" / "Transaction cancelled" and never recorded as an error.

---

## 5. System Architecture

DustSweep spans three deployable units in the monorepo plus on-chain contracts:

| Component | Location | Responsibility |
|---|---|---|
| Web frontend | `apps/web` (Next.js) | `/dustsweep` page, wallet detection, route resolution, signing, transaction submission. |
| Frontend API proxy | `apps/web/src/app/api/dustsweep/*` | Thin Next.js route handlers that proxy `/tokens`, `/quote`, `/build-tx`, `/record-sweep` to the backend API (`proxyDustSweepRequest`). |
| Backend API | `apps/api` (Hono) | Token discovery, pricing, risk classification, quoting, calldata building, whitelist sync, sweep recording. Routes live in `apps/api/src/routes/dustsweep.ts`. |
| Database | Postgres (via `postgresDb`) | Token whitelist, discovery cache, routeability cache, sweep history, points. |
| Smart contracts | `packages/contracts` (Foundry) | `DustSweepRouter` (V1), `DustSweepPermit2RouterV2` (V2), `DustSwapSweepRouter` (V3), `FeeCollector`. |

External dependencies:

- **Alchemy** — Base RPC + `alchemy_getTokenBalances` for wallet-wide ERC-20 discovery.
- **DexScreener** — token prices, liquidity, best-DEX hints (primary market data source).
- **CoinGecko** — price fallback.
- **0x Swap API** — optional aggregator quote source (`DUST_SWEEP_ENABLE_AGGREGATORS=true`, via the 0x AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734`).
- **On-chain quoters** — Uniswap V3 QuoterV2, Uniswap V4 Quoter, PancakeSwap V3 Quoter, Aerodrome router `getAmountsOut`, Aerodrome Slipstream Quoter, BaseSwap router `getAmountsOut`.

Request path for a sweep:

```
Browser (useDustSweep)
  → Next.js /api/dustsweep/* (proxy)
    → Hono API /dustsweep/* (discovery, quote, build-tx)
      → Alchemy RPC / DexScreener / CoinGecko / 0x / on-chain quoters
  ← routes + typed data + calldata
Browser
  → Wallet (sign / wallet_sendCalls / eth_sendTransaction)
    → DustSwapSweepRouter (V3) on Base
      → Permit2 (input pull) → allowlisted DEX routers (swaps) → FeeCollector (fee) → user (net output)
```

### Deployed addresses (Base mainnet)

These values are taken from repository configuration and deployment artifacts. **TODO: confirm each address on BaseScan before publishing.**

| Contract | Address | Source |
|---|---|---|
| DustSweepRouter (V1) | `0x2eb53aed1f45fd6aa5c1db29531eff40e7b36949` | Foundry broadcast + env |
| DustSweepPermit2RouterV2 (V2) | `0x6d3C31E4a2b8e1Fe9De0d260D142183E82cbE1E3` | env (`DUST_SWEEP_ROUTER_V2_ADDRESS`) |
| DustSwapSweepRouter (V3) | `0x06e6BAa61A5Da1E4469FCa5dEa3EB68324255E20` | env (`DUST_SWEEP_ROUTER_V3_ADDRESS`) |
| FeeCollector | **TODO — conflicting values in repo config** (`0x37f9…c7d3` in broadcast, `0xE094…3733` and `0xd4a1…f18a` in env files). Confirm the live collector on-chain. | broadcast + env |
| Permit2 (canonical, Uniswap) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | constant |
| WETH (Base) | `0x4200000000000000000000000000000000000006` | constant |

---

## 6. Token Balance Discovery

Implemented in `apps/api/src/routes/dustsweep.ts` (`handleDustSweepTokensRequest`) and consumed by `useTokenBalances.ts`.

**Discovery is wallet-first, not whitelist-first.** The backend fetches *all* ERC-20 balances via Alchemy `alchemy_getTokenBalances` (paginated, 100 per page, bounded by `DUST_SWEEP_ALCHEMY_MAX_PAGES` / `DUST_SWEEP_DISCOVERY_MAX_ERC20_BALANCES`), filters to non-zero balances, then enriches them. The internal token whitelist (a Postgres table synced from DexScreener, Blockscout, token lists, on-chain pool events — see the `syncDustSweepWhitelist*` scripts) is used only as a metadata and liquidity **hint**, never as a visibility gate.

Enrichment per token:

1. **Market hints** — DexScreener (price USD, liquidity USD, best DEX, logo), with CoinGecko as a price fallback. Concurrency- and timeout-bounded.
2. **Metadata** — symbol/name/decimals from the whitelist row if present, otherwise an on-chain `symbol()/name()/decimals()` read (cached ~24h).
3. **Risk classification** (`getRiskClassification`) — produces a risk score and reasons from symbol/name heuristics, metadata presence, price, liquidity, and whitelist verification. Two outcomes matter: `blockedFromSweep` (classified `SPAM`, reason `SPAM_OR_DENYLISTED`) and `hiddenByDefault`.

Classification buckets returned to the frontend:

| Bucket | Condition |
|---|---|
| `swappable` | Priced, not spam-blocked, value ≥ `DUST_SWEEP_MIN_VALUE_USD` (default $0.01). |
| `hidden` | Known price but value below threshold (`BELOW_THRESHOLD`), or no price at all (`UNKNOWN_PRICE`). |
| `suspicious` | Spam/denylist heuristics tripped (`SPAM_OR_DENYLISTED`). |
| `unavailable` / `excludedOutputAssets` | Other exclusions (e.g. the asset is an output asset). |

Caching: an in-memory runtime cache (default 30 s TTL) in front of a Postgres cache (default 90 s TTL), keyed per wallet address. The response includes a `discovery` block (scanned counts, page counts, truncation flag, elapsed ms) that the UI surfaces during scanning.

**Native ETH** is shown but is not sweepable as an input (`NATIVE_WRAP_REQUIRED` — it must be wrapped to WETH first; the router's entrypoint is non-payable and rejects the native sentinel as `tokenIn`).

---

## 7. Route Generation

Implemented in `POST /dustsweep/quote`.

**Inputs:** `tokenIns[]`, `amounts[]`, `tokenOut`, `slippageBps` (clamped to 1–3000, frontend default 50 = 0.5%), `userAddress`.

**Pipeline:**

1. **Validation & filtering.** Token count must not exceed the lane cap (50 for `owned_v2`/V3, 10 for V1). Inputs equal to the output token are dropped. Native ETH inputs are skipped with `NATIVE_WRAP_REQUIRED`. WETH→native-ETH is currently skipped (no no-op unwrap leg; see Limitations).
2. **Live balance check.** Each token's on-chain balance is re-read; if the wallet no longer holds at least the requested amount, the token is skipped with `BALANCE_CHANGED`.
3. **Routeability pre-screen.** A two-layer cache (runtime memory + Postgres `dustsweep_routeability_cache`, with amount-bucketed keys) short-circuits tokens recently known to have `NO_ROUTE`, so repeated scans don't re-quote dead tokens.
4. **Best-quote fan-out** (`getBestQuote`). For each token, all of the following are quoted **in parallel**, and the highest `amountOut` wins:
   - Uniswap V3 (QuoterV2; fee tiers 500/3000/10000/100, plus two-hop paths through intermediate assets with curated fee pairs)
   - PancakeSwap V3 (Quoter; fee tiers 500/2500/10000/100)
   - Uniswap V4 (V4 Quoter; executed through the V4-capable Universal Router)
   - Aerodrome classic (Solidly `getAmountsOut`, volatile + stable routes)
   - Aerodrome Slipstream (concentrated liquidity; tick spacings 100/200/2000/50/1)
   - BaseSwap (UniV2-style `getAmountsOut`)
   - 0x aggregator (optional; only when aggregators are enabled, and only candidates executable in the current lane survive the filter)
5. **Per-route slippage floor.** `amountOutMin = quotedOut × (10000 − slippageBps) / 10000`, computed per token.
6. **Aggregates.** The response includes `totalEstimatedOut`, `protocolFeeAmount` (fee bps × total), `netEstimatedOut`, USD figures, `feeBps`, a heuristic gas estimate, a **30-minute deadline**, and a freshly generated random 128-bit `permit2Nonce`.
7. **Router-level `minAmountOut`.** Lane-dependent (see Section 16): for V3 it is the *minimum* single-leg floor (because legs are best-effort and refundable); for V2 it is the *sum* of all leg floors.

Tokens with no viable route are returned in `skippedTokens` with machine-readable reasons (`NO_LIQUIDITY`, `QUOTE_FAILED`, `BALANCE_CHANGED`, `BELOW_THRESHOLD`, `NATIVE_WRAP_REQUIRED`). If *no* token routes, the endpoint returns `NO_SWAPPABLE_ROUTES`.

---

## 8. DEX / Router Whitelist

The V3 sweep router only calls **owner-allowlisted** swap targets, and tokens can only be pulled by **owner-allowlisted** spenders. The verified registry lives in `apps/api/src/config/dustsweepV3Sources.ts` and is the single source of truth for both the on-chain allowlist (`setAllowedTarget` / `setAllowedSpender`) and the off-chain calldata builders.

| DEX | Target (called) | Spender (pulls tokens) | Spender model |
|---|---|---|---|
| Uniswap Universal Router (V3+V4) | `0x6fF5693b99212Da76ad316178A184AB56D299b43` | Permit2 | `permit2` |
| Uniswap V3 SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` | itself | `self` |
| Aerodrome Universal Router | `0x6Cb442acF35158D5eDa88fe602221b67B400Be3E` | Permit2 | `permit2` |
| Aerodrome Classic Router (Solidly) | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` | itself | `self` |
| Aerodrome Slipstream SwapRouter | `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` | itself | `self` |
| PancakeSwap SmartRouter | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` | itself | `self` |
| AlienBase SmartRouter | `0xB20C411FC84FBB27e78608C24d0056D974ea9411` | itself | `self` |
| DackieSwap SmartRouter | `0x195FBc5B8Fbd5Ac739C1BA57D4Ef6D5a704F34f7` | itself | `self` |
| BaseSwap Router | `0x327Df1E6de05895d2ab08513aaDD9313Fe505d86` | itself | `self` |

Per the registry's own provenance notes, each address was verified live on Base via `eth_getCode` and cross-checked against official docs / verified BaseScan labels on 2026-06-09. **TODO: confirm which of these targets are currently enabled on the live V3 contract's on-chain allowlist** (the registry is the intended set; `enabled: true` for all nine in code).

Two spender models exist, and both preserve the exact-amount guarantee:

- **`self`** — the DEX router pulls tokens via a plain ERC-20 allowance. The sweep router `forceApprove(dexRouter, amountIn)` and resets to 0 immediately after the swap call.
- **`permit2`** — Universal Router-style contracts pull through Permit2. The sweep router grants a *transient* Permit2 AllowanceTransfer approval of exactly `amountIn` (expiring at the sweep deadline) and resets it to 0 after the call.

Enforcement happens in three layers:

1. **Off-chain (build-tx):** every built route is checked against the configured allowlist (`assertConfiguredV2Route`), and additionally verified against the *on-chain* `allowedTargets`/`allowedSpenders` mappings (`assertOnchainV2RouterAllowlist`) before calldata is returned.
2. **On-chain (router):** `_validateRoutes` reverts with `TargetNotAllowed`/`SpenderNotAllowed` for anything not allowlisted.
3. **Config sync:** when V3 is active, the backend automatically trusts the verified V3 registry, so `DUST_SWEEP_ALLOWED_TARGETS`/`SPENDERS` env lists don't need hand-editing per DEX.

---

## 9. Permit2 Approval Flow

Permit2 (canonical Uniswap deployment, `0x000000000022D473030F116dDEE9F6B43aC78BA3`) is the backbone of the non-batching path ("Route C") and of Universal-Router swap legs.

**Where Permit2 is used:**

1. **User → router input pull (SignatureTransfer).** In `Permit2Signature` mode, the router calls `permit2.permitWitnessTransferFrom(permit, transferDetails, msg.sender, witness, PERMIT2_WITNESS_TYPE_STRING, signature)`. This is a *one-shot* transfer authorization: exact token list, exact amounts, single-use nonce, hard deadline, no standing allowance. The Permit2 `owner` parameter is hardcoded to `msg.sender`, so a signature can only ever be spent by the wallet that signed it.
2. **Router → Universal Router legs (AllowanceTransfer).** For Uniswap/Aerodrome Universal Router targets (spender model `permit2`), the router grants a transient `IAllowanceTransfer.approve(token, target, amountIn, deadline)` immediately before the swap call and resets it to `(0, now)` immediately after.

**What the user approves (Route C, first time per token):** a standard ERC-20 `approve(Permit2, amount)` per token. The frontend computes exact requirements via `getTokenApprovalRequirements` — it reads the live allowance and only requests the missing amount; tokens with non-standard approve semantics (USDT-style) get a reset-to-zero first (`resetFirst`). After Permit2 has allowance for a token, subsequent sweeps need **no further on-chain approvals** — just the off-chain signature.

> Note: the EIP-7702 design document describes the Route C setup as a one-time `approve(Permit2, max)`. The implemented code requests **exact amounts** per sweep (`approvalAmount = requirement.amount`). Exact approvals are the safer behavior; the "approve once, reuse forever" UX claim applies only insofar as a previous approval still covers the new amount. **Needs confirmation** which behavior is intended product policy.

**Operating mode note:** the backend's `DUST_SWEEP_V2_AUTH_MODE` selects between `allowance` (default — exact ERC-20 approvals to the router itself + `sweep` in Allowance mode, signature-free, ideal for wallet batching) and `permit2` (signature flow described above). The repository's env sets `allowance`. **Needs confirmation: which mode is live in production.** Both modes are fully implemented and the frontend handles both via the `requiresSignature` flag in the build-tx response.

**Security implications:**

- No infinite approvals to the DustSweep router are ever requested in any mode.
- A leaked/phished Permit2 *signature* for DustSweep is constrained: it can only move the exact listed tokens/amounts, only to the sweep router, only before the deadline, and only when submitted by the signer's own address — and the witness binds the full sweep intent (Section 10).
- The standing user→Permit2 ERC-20 allowance is the same allowance shared by all Permit2-integrated apps (Uniswap etc.); it does not grant DustSweep anything by itself.

**User-facing explanation (suggested copy):** "You sign one message that lets the sweep contract pull exactly the tokens and amounts you selected, for this sweep only, expiring in 30 minutes. No unlimited approvals, nothing reusable by anyone else."

---

## 10. EIP-712 Signing

In the Permit2 path, the user signs a single EIP-712 typed-data message: `PermitBatchWitnessTransferFrom` against the Permit2 domain (`name: "Permit2"`, `chainId: 8453`, `verifyingContract: Permit2`).

The message contains:

- `permitted[]` — `{token, amount}` for every input token, matching the routes exactly (the contract reverts on any mismatch: `PermitTokenMismatch`, `PermitAmountMismatch`, `PermitLengthMismatch`).
- `spender` — the sweep router address.
- `nonce` — random 128-bit value from the quote (single-use; Permit2 enforces non-replay).
- `deadline` — the quote deadline (30 minutes).
- `witness` — a `DustSweepWitness` struct that binds the **entire sweep intent**.

Witness fields differ by router generation:

| Field | V2 witness | V3 witness |
|---|---|---|
| `routeHash` | ✓ keccak over every route (tokenIn, amountIn, target, spender, value, calldata hash; order-sensitive) | ✓ same construction |
| `outputToken` | ✓ | ✓ |
| `receiver` / `recipient` | `receiver` | `recipient` |
| `minAmountOut` | ✓ | ✓ |
| `deadline` | ✓ | ✓ |
| `feeBps` | — | ✓ **the exact fee charged is signed** |

Because the witness commits to the route hash, output token, recipient, slippage floor, deadline, and (V3) fee, the backend cannot alter any of these after signing — the contract recomputes the witness and Permit2 verifies the signature against it. Tampering with any field invalidates the signature.

Smart-contract signers (EIP-1271) are supported implicitly: Permit2 validates EIP-1271 signatures for contract accounts, and the V3 entrypoint is caller-agnostic.

The typed data is constructed server-side (`buildV3WitnessTypedData` / `buildPermit2WitnessTypedData`) and returned by `/build-tx`; the frontend passes it unmodified to `walletClient.signTypedData`. For V3, after signing, the frontend re-posts `/build-tx` with the signature so the backend encodes the final `sweep()` calldata against the real V3 ABI.

---

## 11. EIP-5792 Batching

EIP-5792 (`wallet_getCapabilities` / `wallet_sendCalls` / `wallet_getCallsStatus`) is how DustSweep collapses N approvals + 1 sweep into a single wallet prompt on capable wallets.

**Capability detection** (on connect, in `useDustSweep`): the hook calls `wallet_getCapabilities` against every available provider candidate, trying multiple parameter shapes (`[address, [chainIdHex]]`, `[address, ["8453"]]`, `[address]`, `[]`) for wallet compatibility. The Base-chain capability object is inspected for `atomic.status` (per the current spec: `"supported"` / `"ready"`) with a legacy `atomicBatch.supported` fallback. Result: `supported`, `ready` (wallet can batch after a one-time self-upgrade prompt), `unsupported`, or `unknown`.

**Batch execution** (route kind `batch`): the approvals (exact-amount ERC-20 `approve` calls to the router) and the `sweep()` call are submitted as one `wallet_sendCalls` request, version `2.0.0`, with `atomicRequired: true`. The implementation prefers viem's `sendCalls`/`waitForCallsStatus` wrappers and falls back to raw provider RPC (for OKX it goes straight to the injected provider). Completion is tracked via `wallet_getCallsStatus` polling (up to 180 s), checking both the batch status and per-receipt status, and rejecting batches that executed non-atomically when atomicity was required.

**Call-count limits and shaping:**

- Default cap: 50 calls per batch (`NEXT_PUBLIC_DUST_SWEEP_WALLET_BATCH_CALL_CAP`); MetaMask is capped at 10.
- Coinbase/Base Account: at or below 10 routes (`SINGLE_BATCH_ROUTE_LIMIT`), approvals + sweep go in **one** prompt; above it, DustSweep splits into exactly two prompts (approvals batch, then sweep) for reliable estimation. A paymaster capability is attached when `NEXT_PUBLIC_PAYMASTER_URL` is configured.
- If approvals alone exceed the cap, they are **chunked** into successive batches, with the sweep appended to the last chunk when it fits.
- TokenPocket: a dedicated path supplies explicit per-call gas (bypassing TokenPocket's failing internal `eth_estimateGas`), uses `atomicRequired: false` retries, and splits approvals-then-sweep.

**Fallback ladder when batching is unavailable or fails:** wallet rejects / errors on `wallet_sendCalls` → classified by `isBatchFallbackError` (EIP-5792 error codes 4100/5700/5710/5740/5750/5760, "atomicity not supported", "method not found", etc.) → fall back to bundled-approvals-then-sweep, then to fully sequential approvals + a standard `eth_sendTransaction` sweep, with an honest UI notice at each downgrade. User rejections are never retried as fallbacks. MetaMask approval batching is additionally behind a feature flag (`NEXT_PUBLIC_DUST_SWEEP_METAMASK_BATCH_APPROVALS`, currently `false` — "disabled for safety" per the in-app notice).

If the wallet supports neither EIP-5792 nor EIP-712 typed signing, the wallet gate (Section 18) blocks the sweep with a clear message — but EIP-712 support alone is enough for the Permit2 path, so virtually all modern wallets pass.

---

## 12. EIP-7702 Delegation Support

EIP-7702 lets an EOA delegate to a smart-account implementation; the account's code becomes `0xef0100 ‖ <delegate address>`. This is on-chain, per-chain state on the address itself — and it is the root cause of confusing cross-wallet batching failures (e.g. an account upgraded by OKX will refuse to batch in MetaMask).

**Detection** (`apps/web/src/lib/eip7702.ts`): after switching to Base, the frontend reads `eth_getCode` for the connected address and parses the `0xef0100` designator → delegate address or `null`. The delegate is resolved against `KNOWN_DELEGATES`, a self-curated registry (there is no canonical public registry) mapping delegate implementations to wallet brands and infra providers. Unknown delegates are logged via telemetry so the registry can grow from real sessions. The registry is **labels only — it never gates execution**; the wallet's reported atomic capability is the gate.

Registered wallet-brand delegates on Base (see `DustSweep-EIP7702-Registry.md` for provenance):

| Wallet | Delegate address(es) |
|---|---|
| MetaMask Smart Account | `0x63c0c19a282a1b52b07dd5a65b58948a07dae32b` |
| OKX Wallet | `0xe40ccb2d94975c51bff0c004efdfd9b3a5796fa4`, `0x80296ff8d1ed46f8e3c7992664d13b833504c2bb` |
| Base Account / Coinbase Wallet | `0x7702cb554e6bfb442cb743a7df23154544a7176c` |
| TokenPocket | `0xcc0c946eecf01a4bc76bc333ea74ceb04756f17b` |
| Trust Wallet | `0xd2e28229f6f2c235e57de2ebc727025a1d0530fb` |
| Uniswap Wallet | `0x000000009b1d…8f00`, `0x0c338ca2…281f`, `0x458f5a9f…312c` |
| Ambire | `0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d` |
| Bitget Wallet | `0xa845c743…c1bf`, `0x4428a93b…5433` |
| Rainbow | `0x612373d7003d694220f7800eeaf8e3924c0951d3` |

Plus ~17 labeled infra/service delegates (Alchemy, Biconomy, Thirdweb, ZeroDev, Porto, Fireblocks, Gelato, Pimlico, …) recorded as `wallet: "unknown"` so the UI can name them without offering a wallet switch. Extra delegates can be injected without redeploy via `NEXT_PUBLIC_EXTRA_KNOWN_DELEGATES` (JSON env).

**Route matrix** (implemented in `useDustSweep.routeKind`, hardened beyond the design doc):

| On-chain delegation (Base) | Connected wallet atomic | Resolved route |
|---|---|---|
| Delegated to a *known other* one-click wallet | any | `switch_or_permit2` — offer "Switch to {wallet}" + Permit2 fallback |
| TokenPocket's own delegate, connected via TokenPocket | any (capability probe is flaky in-app) | `batch` (own delegate proves ownership) |
| Not delegated, or delegated to the *connected wallet's own* delegate | `supported`/`ready` | `batch` |
| Anything else (foreign/unknown delegate, or no atomic support) | — | `permit2` |

Key hardening detail: a wallet's `atomic: supported` claim is **only trusted when the account is undelegated or delegated to that same wallet's family** — some wallets report atomic support on a foreign-delegated EOA and then fail at execution time.

**Wallet-compatibility consequences (as encoded in UI notices and the registry doc):**

- **MetaMask** — will not batch on an account delegated to a third party; DustSweep detects this and routes to Permit2 with an explanatory notice. MetaMask approval batching is also feature-flagged off by default.
- **OKX, Coinbase/Base Account, MetaMask, TokenPocket, Uniswap, Ambire** — advertised one-click (batch) wallets.
- **Rainbow, Trust** — delegates are recognized for labeling, but one-click promotion is behind env flags (`…_RAINBOW_ONE_CLICK` / `…_TRUST_ONE_CLICK`, default off) because their public EIP-5792 support was not verified.
- **Bitget** — supports EIP-7702 only via manual in-wallet binding; DustSweep shows guidance and uses Sign & Sweep until public batch support is verified.
- **Rabby, Phantom, Zerion, imToken, Crypto.com, Safe** — no verified public delegate; they use the Permit2 route.

**Fallback UX copy** (from `getWalletBatchNotice` / the design doc): a foreign-known delegation produces "This address is already set up for one-click batching with **{OKX Wallet}**… connect with {OKX} — or continue with {MetaMask} and we'll sweep with a single signature + one transaction instead", with **Switch** and **Continue** actions. A dApp cannot re-delegate the account itself; switching wallets (or resetting the delegation inside the owning wallet) is the only path to batch, and Permit2 always remains available so no user is hard-blocked.

---

## 13. DustSweep Router / V3 Router

**Contract:** `DustSwapSweepRouter` (`packages/contracts/src/DustSwapSweepRouter.sol`), Solidity ^0.8.20, OpenZeppelin `Ownable` + `ReentrancyGuard` + `Pausable`. Deployed at `0x06e6BAa61A5Da1E4469FCa5dEa3EB68324255E20` per repo config (**TODO: confirm on BaseScan, including verification status**). Constructor: `(permit2, weth, owner, feeCollector, feeBps)`.

**Single entrypoint:**

```solidity
function sweep(
    SweepMode mode,                 // Permit2Signature = 0 | Allowance = 1
    SweepRoute[] calldata routes,   // {tokenIn, amountIn, target, spender, value, data}
    SweepParams calldata params,    // {outputToken, recipient, minAmountOut, deadline, feeBpsOverride}
    ISignatureTransfer.PermitBatchTransferFrom calldata permit,  // Permit2 mode only
    bytes calldata signature                                      // Permit2 mode only
) external nonReentrant whenNotPaused
  returns (uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut);
```

**Constants:** `MAX_BATCH_SIZE = 50`, `MAX_FEE_BPS = 300` (3% hard cap), `FEE_OVERRIDE_SENTINEL = type(uint16).max` (= use contract default fee), `NATIVE_TOKEN_SENTINEL = 0xEeee…EEeE` (native ETH output via WETH unwrap). The entrypoint is non-payable; `route.value` must be 0 (ERC-20 inputs only).

**Execution sequence:**

1. Resolve effective fee (`feeBpsOverride` or default; both capped at 3%).
2. Validate params and every route (allowlisted target & spender, non-zero amounts, calldata ≥ 4 bytes, `tokenIn ≠ outputToken`, deadline not passed, ≤ 50 routes).
3. Snapshot the router's balance of the output token and of every unique input token (delta accounting — pre-existing balances can never be swept or refunded to a caller).
4. Pull inputs: Permit2 `permitWitnessTransferFrom` (witness-bound) or plain `safeTransferFrom` — always **exactly** `route.amountIn`.
5. Execute each route **best-effort** via `try this.executeRoute(route, deadline)` (external, self-only):
   - Guard: revert `InsufficientHeldBalance` if the router holds less than `amountIn` (fee-on-transfer protection — never over-approve).
   - `forceApprove(spender, 0)` → `forceApprove(spender, amountIn)`; for Permit2-spender targets, additionally a transient `IAllowanceTransfer.approve(token, target, amountIn, deadline)`.
   - `target.call(data)`; both approval rails reset to 0 regardless of outcome.
   - On success → `RouteExecuted`; on failure → the `try/catch` rolls back that leg's state entirely and emits `RouteSkipped(tokenIn, amountIn, reason)` — the batch continues.
6. Refund leftover inputs (Section 17).
7. Settle output: measure the output delta, enforce `minAmountOut` (`InsufficientOutput`), transfer the fee to the collector (`ProtocolFeePaid`), deliver the net — unwrapping WETH→ETH for native output — and emit `DustSwept(user, recipient, outputToken, routeCount, grossAmountOut, feeAmount, netAmountOut)`.

**Admin surface (owner-only):** `setFeeBps`, `setFeeCollector`, `setAllowedTarget`, `setAllowedSpender`, `pause`/`unpause`, `rescueERC20`, `rescueNative`. `receive()` only accepts ETH from the WETH contract.

**Differences from V2** (`DustSweepPermit2RouterV2`, still deployed): V2 has two entrypoints (`sweepWithPermit2`, `sweepWithAllowance`), is **all-or-nothing** (any failed swap leg reverts the entire sweep), has no native-ETH output, no pause switch, no per-sweep fee override, and its witness does not bind the fee. V3 was deployed as a brand-new contract; the app was switched by pointing one env value at the V3 address, with no runtime V2/V3 fallback.

**Audit status:** an internal security review of V3 exists in-repo (`DustSwapSweepRouter_Audit_Report.md`, dated 2026-06-09): 0 critical, 0 high, 2 medium (owner-allowlist trust concentration; per-leg slippage not enforced on-chain), 3 low, several informational. **TODO: confirm whether an independent third-party audit has been commissioned; do not describe the contract as "audited" by an external firm until then.**

---

## 14. Transaction Lifecycle

End-to-end, by route kind. In all cases, the calldata executed on-chain is built server-side against the verified ABI, the frontend appends a builder-code data suffix for attribution, and the receipt is verified (`status === "success"`) before showing success.

**Route A — `batch` (EIP-5792 wallets):**

1. `POST /build-tx` (allowance mode) → exact approval requirements + `sweep(Allowance, …)` calldata.
2. One `wallet_sendCalls` bundle: `approve(router, exactAmount)` per token + the sweep call, `atomicRequired: true`. (Split/chunked variants per Section 11.)
3. Poll `wallet_getCallsStatus` until a transaction hash appears; reject on failed receipts or non-atomic execution.

**Route C — `permit2` (signature wallets):**

1. `POST /build-tx` (permit2 mode) → approval requirements (spender = Permit2), EIP-712 typed data, witness, permit.
2. If any token lacks Permit2 allowance: sequential `approve(Permit2, exactAmount)` transactions ("Setup" step).
3. User signs the `PermitBatchWitnessTransferFrom` typed data ("Sign" step — off-chain, no gas).
4. (V3) Re-POST `/build-tx` with the signature → final `sweep(Permit2Signature, …)` calldata.
5. One `eth_sendTransaction` to the router ("Sweep" step).

**Standard approvals (allowance mode, non-batching wallet):** sequential exact `approve(router, amount)` transactions, then one `sweep(Allowance, …)` transaction.

**Server-side safety rails on `/build-tx`:** rejects expired deadlines (409 `DEADLINE_EXPIRED`), stale balances re-checked at build time (409 `STALE_TOKEN_BALANCE`), input==output overlap, native inputs, over-cap batches, unconfigured router, and any route whose target/spender fails the configured **and** on-chain allowlist checks.

**Post-confirmation:** the frontend records the sweep (`/record-sweep` → sweep history row keyed by tx hash + points/quest progress: FIRST_SWEEP, SWEEP_10_TOKENS, SWEEP_50_TOKENS, SWEEP_100_USD, SWEEP_5_TIMES), shows the completion summary with a BaseScan link, clears the selection, and rescans balances. Per-sweep route telemetry (wallet key, delegate, atomic status, route kind, outcome) is logged to grow the delegate registry.

**Failure handling in the UI:** user rejections → "Approval cancelled"/"Transaction cancelled"; wallet locked → unlock prompt; batch-capability errors → automatic downgrade with notice (Section 11); on-chain revert → "Transaction reverted" mapped through `parseDustSweepError`. A re-entrant click while a sweep is pending is suppressed ("A sweep request is already waiting in your wallet").

---

## 15. Fee Handling

- The protocol fee is taken **once, at settlement, from the realized output** — never per-leg, never from inputs: `feeAmount = grossAmountOut × feeBps / 10 000`, transferred to `feeCollector`, with the remainder going to the recipient.
- **On-chain hard cap: `MAX_FEE_BPS = 300` (3%)** in both V2 and V3. The constructor and `setFeeBps` enforce it; V3 also caps any per-sweep override.
- **Configured fee:** the backend reads `DUST_SWEEP_FEE_BPS` (code default 200 = 2%). Repository env files contain both `200` and `60` (0.6%), and the frontend display default is 60. **TODO: confirm the current production fee (on-chain `feeBps` + env override) and align frontend display, backend env, and contract state before publishing a number.**
- **V3 fee binding (audit finding L-1 remediation):** the backend always passes an **explicit** `feeBpsOverride` (never the sentinel), and in Permit2 mode the fee is inside the signed witness — so the fee a user signs is exactly the fee charged, and the owner cannot change the fee of an in-flight signed sweep. In Allowance mode the explicit override provides equivalent protection.
- Quotes return `protocolFeeAmount`, `netEstimatedOut`, and USD equivalents so the fee is visible before signing.
- Known quirk (audit I-1): for native-ETH output sweeps, the fee is paid to the collector in **WETH** while the user receives unwrapped ETH. Intentional per current code.

---

## 16. Slippage and Failure Handling

**Two layers of slippage protection:**

1. **Per-leg, inside DEX calldata:** every leg's swap calldata encodes `amountOutMinimum = quote × (1 − slippage)` (user-configurable, default 0.5%, max 30%). A leg that can't meet its own floor reverts — in V3 that leg is *skipped and refunded*, not fatal.
2. **Aggregate, on the router:** `params.minAmountOut` is enforced at settlement (`InsufficientOutput` reverts the whole sweep). For V3 the backend sets this to the **minimum single-leg floor** — deliberately, so that one refunded dust route can't revert an otherwise-successful batch; the per-leg floors carry the real slippage protection. For V2 (all-or-nothing) it is the **sum** of all leg floors.

**Failure semantics (V3):** failed legs → `RouteSkipped` + input refund; the sweep succeeds with whatever legs cleared. The internal audit (M-2) correctly notes that per-leg minimums live in calldata rather than router state — the router only enforces the aggregate floor — so quote freshness and tight per-leg floors are security-critical responsibilities of the backend. **(V2: any leg failure reverts everything; nothing is spent.)**

**Pre-flight failure prevention:** live balance re-checks at quote *and* build time, deadline checks at quote/build/contract level (30-minute quote validity), routeability caching to avoid quoting known-dead tokens, and high-price-impact (>5%) user confirmation.

**Fee-on-transfer inputs:** if a token delivers less than `amountIn` to the router, the `InsufficientHeldBalance` guard fails that leg before any DEX approval, and the partial balance is refunded — the router never over-approves.

---

## 17. Refund Logic

V3's refund mechanism guarantees no input is stranded by a failed or skipped leg:

1. **Snapshot before pull:** `_snapshotInputs` records the router's balance of every unique input token *before* any tokens are pulled.
2. **After execution:** `_refundLeftoverInputs` measures each input token's balance delta. Anything above the snapshot — inputs of skipped legs, fee-on-transfer remnants, DEX router refunds — is transferred back to the caller, emitting `InputRefunded(token, to, amount)`.
3. **Refunds are themselves best-effort:** the refund uses a raw `call` with careful return-data handling (non-compliant ERC-20 returns are tolerated, short returns never decoded), so one pathological token cannot brick the batch. A failed refund emits `RefundFailed(token, to, amount)` and leaves the tokens recoverable by the owner's `rescueERC20` for manual return.
4. **Delta accounting protects everyone else:** because only the *delta brought in by this transaction* is refundable, pre-existing or donated balances on the router can never be claimed by a sweeping user.

V2 has no refund path — it doesn't need one, since any failure reverts the entire transaction and no tokens move. V1 likewise reverts on failure.

---

## 18. Wallet Compatibility

**Gate (who can sweep at all):** capability-based, not brand-based (`useWalletWhitelist`). Any wallet exposing `signTypedData` (EIP-712) + `sendTransaction` is supported — by design ~99% of wallets. Tiers: `tier1` = Coinbase smart wallets (paymaster-eligible), `tier2` = any EIP-712-capable wallet, `blocked` = wallets that cannot sign typed data (these see a slim inline notice with a switch-wallet action, never a hard full-screen block).

**Execution tier (what experience a wallet gets)** — resolved at runtime from EIP-5792 capability + EIP-7702 delegation state, never from a hardcoded brand list:

| Wallet | Expected experience (as encoded in code/notices) |
|---|---|
| Coinbase Wallet / Base Account | One-click batch (atomic `wallet_sendCalls`); optional paymaster; auto-split into 2 prompts above 10 routes. Batching attempted even if the capability probe is flaky in-app. |
| OKX Wallet | One-click batch via injected provider (bypasses viem wrapper quirks); recognized own delegate. |
| MetaMask | EIP-7702 Smart Account batch supported, but approval batching is currently feature-flagged **off** ("disabled for safety" notice) → Permit2/standard flow by default; 10-call batch cap when enabled. Refuses to batch on foreign-delegated accounts. |
| TokenPocket | Dedicated path: explicit per-call gas, approvals batched first then sweep, own-delegate detection unlocks batching despite flaky capability reporting. |
| Uniswap Wallet, Ambire | Recognized one-click delegates. |
| Bitget | Manual in-wallet EIP-7702 binding required; Sign & Sweep until public batch support is verified. |
| Rainbow, Trust | Delegates recognized for labeling; one-click promotion behind env flags (off by default) pending verified EIP-5792 support. |
| Rabby | No public atomic batching → Permit2 route with explanatory notice. |
| Phantom, Zerion, imToken, Crypto.com, Safe, WalletConnect wallets | Permit2 route (signature + one transaction). |

**TODO:** the table above reflects code paths and notices as of this review; re-verify each wallet's behavior on current production builds before publishing a public "supported wallets" list, since wallet capabilities change frequently.

---

## 19. Security Model

**Non-custodial design.** The router holds user tokens only within a single transaction. Delta-based accounting (input snapshots, output delta) means pre-existing balances can't be claimed and refunds return only what the transaction brought in. Between transactions the router is expected to hold ~0.

**Approvals.** The single most important invariant, stated in the contract header as non-negotiable: `route.amountIn` is the single source of truth. The user permits/approves exactly that amount per token; the router pulls exactly that; the router approves the DEX exactly that and resets to 0 immediately after — on success *and* on failure (the `try/catch` rolls back a failed leg's approvals atomically). No infinite or standing allowance path to the router exists in any mode.

**Permit2 signature safety.** Permits are caller-bound (`owner = msg.sender` — relayed signatures are structurally unusable by others), single-nonce, deadline-bound, and witness-bound to routes + output + recipient + minAmountOut + deadline (+ fee on V3).

**Router trust assumptions** (from the internal audit, M-1): each route executes backend-supplied calldata against an owner-allowlisted target while the router holds that leg's input. The roots of trust are therefore (a) the owner key (allowlist, fee ≤ 3%, pause, rescue) and (b) the backend route builder (calldata, per-leg floors, `minAmountOut`). The audit recommends a multisig + timelock for the owner and treating allowlist additions as high-assurance operations. **TODO: document the actual owner setup (EOA vs multisig, timelock or not) — currently the deployment guide implies a single deployer EOA owner. Needs confirmation.**

**Reentrancy & control.** `sweep`/rescues are `nonReentrant`; `executeRoute` is self-only; callbacks from tokens/DEXes during a sweep hit the active guard. `Pausable` provides an emergency stop (V3). Owner can rescue stuck funds but cannot interleave inside a user's atomic transaction.

**Slippage:** per-leg floors in calldata + aggregate floor on-chain (Section 16); the aggregate is intentionally loose on V3, so per-leg floors are the primary protection — an accepted, documented trade-off (audit M-2).

**Scam prevention:** spam/honeypot heuristics hide suspicious tokens by default (Section 6); unpriced tokens are not sweepable; output tokens are restricted to a short major-asset list, which removes the classic "sweep into a fake token" attack from the UI.

**Known accepted risks** (internal audit, all low/medium): owner-trust concentration (M-1), off-chain slippage responsibility (M-2), fee-on-transfer *output* tokens would shortchange the recipient (L-2 — mitigated by the fixed output list), unguarded fee-collector assumptions, and best-effort gas exhaustion edge cases (I-6).

---

## 20. User Safety Notes

Suggested user-facing guidance, consistent with the implementation:

- DustSweep never asks for unlimited token approvals to its own contracts. Approvals are for the exact amounts being swept. An "Approve" prompt for a large round number to a contract other than Permit2 or the DustSweep router did not come from DustSweep.
- The signature request you see in the Permit2 flow is an off-chain, gas-free EIP-712 message titled `PermitBatchWitnessTransferFrom` from `Permit2`. It lists every token and exact amount, expires in 30 minutes, and only works for your own address. Reject anything that doesn't match what you selected.
- Tokens hidden as "suspicious" are hidden for a reason. Interacting with unknown airdropped tokens outside DustSweep (e.g. visiting URLs in token names) is a common scam vector.
- A sweep can partially succeed: failed tokens are refunded to your wallet automatically in the same transaction (look for `RouteSkipped`/`InputRefunded` in the transaction logs).
- The protocol fee is capped at 3% on-chain and shown before you sign; in the signature flow the exact fee is part of what you sign.
- If your account was upgraded (EIP-7702) by another wallet, DustSweep will tell you and still let you sweep — switching wallets is an optimization, never a requirement.
- Always verify you are on the official app domain before connecting. **TODO: confirm canonical production URL (repo README references `https://app.dustswap.wtf`).**

---

## 21. Current Limitations

- **Base only.** Discovery, quoting, and contracts are pinned to chainId 8453.
- **Native ETH cannot be an input.** ETH must be wrapped to WETH first (`NATIVE_WRAP_REQUIRED`); the V3 entrypoint is non-payable.
- **WETH → native ETH is not sweepable** (router rejects `tokenIn == actualOutput`; a no-op unwrap leg is not implemented — audit I-3).
- **Max 50 tokens per sweep** (contract `MAX_BATCH_SIZE`); larger wallets need multiple sweeps.
- **Per-leg slippage floors are off-chain constructed**; the router enforces only the aggregate floor (V3's aggregate is intentionally the minimum leg floor).
- **Output tokens are a fixed list** (ETH/USDC/WETH/USDT) rather than free choice.
- **Unpriced/illiquid tokens can't be swept** even if technically tradable — pricing confidence gates sweepability.
- **Wallet batching reliability varies**; several wallet-specific workarounds exist (TokenPocket gas injection, OKX provider preference, MetaMask batching feature-flagged off), and behavior may shift as wallets update.
- **Fee display vs. configured fee may diverge** across env files (60 vs 200 bps in repo) — see Section 15 TODO.
- **Owner governance** is a single key per the deployment guide (no multisig/timelock confirmed) — see Section 19 TODO.

---

## 22. Future Improvements

Drawn from in-repo TODOs, audit recommendations, and design docs (roadmap status of each: **Needs confirmation**):

- WETH→ETH unwrap leg so WETH dust can sweep to native ETH.
- Per-leg on-chain minimum-output enforcement (audit M-2 recommendation).
- Multisig + timelock ownership and published allowlist-change policy (audit M-1).
- Per-target function-selector constraints on allowlisted routers (audit M-1 hardening).
- `basket_aggregator` execution lane (scaffolded in code; `/build-tx` currently returns 501 for it).
- Promotion of Rainbow/Trust to default one-click wallets once their EIP-5792 support is verified (flags already exist).
- Continued growth of the EIP-7702 delegate registry from telemetry.
- Independent third-party audit. **TODO: confirm plans/status.**
- Additional chains. **Needs confirmation — nothing in code suggests active multi-chain work.**

---

## 23. FAQ

**Is DustSweep custodial?**
No. Tokens move only inside your own transaction: wallet → router → DEX → router → you, atomically. The router keeps nothing but the protocol fee, which goes to the fee collector in the same transaction.

**How many approvals will I see?**
On a batching wallet (Coinbase/Base Account, OKX, and other EIP-5792 wallets): typically **one** prompt for everything. On other wallets: one-time exact approvals for tokens that need setup, then one signature + one transaction. Tokens already approved need no new approval.

**What exactly am I signing?**
A Permit2 `PermitBatchWitnessTransferFrom` message: the exact tokens and amounts, the sweep contract as the only spender, a 30-minute expiry, a single-use nonce, and a witness committing to the routes, output token, recipient, minimum output — and on V3, the exact fee.

**What happens if one of my tokens fails to swap?**
On the V3 router, that token is skipped and refunded to your wallet in the same transaction; the rest of the sweep completes. You'll see `RouteSkipped` and `InputRefunded` events in the transaction.

**What does it cost?**
A protocol fee taken from the output (hard-capped at 3% on-chain; current rate — **TODO: confirm, repo config shows 0.6%–2% candidates**) plus Base gas, which is typically cents even for large batches.

**Why does it say my account is "set up with another wallet"?**
Your address was upgraded via EIP-7702 by another wallet (e.g. OKX). Only one delegation can exist per address per chain, and other wallets won't batch on top of it. DustSweep offers to switch to that wallet for one-click sweeps, or continue where you are with a signature + one transaction.

**Why can't I sweep a token I can see in my wallet?**
Most commonly: no DEX liquidity on Base (`NO_LIQUIDITY`), no reliable price (`UNKNOWN_PRICE`), value below the $0.01 threshold, it's flagged as spam, or it's native ETH (wrap to WETH first).

**Can DustSweep drain my wallet via the approvals?**
No standing approvals to DustSweep contracts exist; everything is exact-amount and per-sweep. The Permit2 contract you may grant a standard allowance to is Uniswap's canonical, widely-audited deployment shared across the ecosystem.

**Is the contract audited?**
An internal security review of the V3 router exists (0 critical / 0 high findings). **TODO: confirm and disclose third-party audit status accurately.**

---

## 24. Glossary

| Term | Definition |
|---|---|
| **Dust** | Token balances too small to be worth selling individually. |
| **Sweep** | One transaction converting many input tokens into a single output token. |
| **Route / leg** | One token's swap within a sweep: `{tokenIn, amountIn, target, spender, value, data}`. |
| **Target** | The allowlisted DEX contract a leg calls. |
| **Spender** | The allowlisted address allowed to pull the leg's input token (the DEX router itself, or Permit2 for Universal Routers). |
| **Permit2** | Uniswap's canonical approval contract; enables signature-based, exact, expiring batch token transfers (`SignatureTransfer`) and managed allowances (`AllowanceTransfer`). |
| **Witness** | Extra struct hashed into the Permit2 signature binding the full sweep intent (routes, output, recipient, min output, deadline, fee on V3). |
| **EIP-712** | Standard for human-readable typed-data signing; used for the Permit2 message. |
| **EIP-5792** | Wallet RPC standard (`wallet_sendCalls` etc.) for submitting batched, optionally atomic call bundles. |
| **EIP-7702** | Lets an EOA set its code to a delegate contract (`0xef0100‖address`), turning it into a smart account; per-chain, one delegate at a time, last write wins. |
| **Delegate** | The implementation contract an EIP-7702 account points to. |
| **Atomic batch** | A call bundle that executes all-or-nothing in one transaction. |
| **Route kind** | DustSweep's resolved execution path: `batch`, `switch_or_permit2`, or `permit2`. |
| **Allowance mode** | V3 input-pull mode using plain exact ERC-20 allowances (pairs with wallet batching). |
| **Permit2Signature mode** | V3 input-pull mode using a signed Permit2 witness transfer. |
| **`minAmountOut`** | Aggregate output floor enforced by the router at settlement. |
| **`amountOutMin`** | Per-leg output floor encoded in DEX calldata. |
| **bps** | Basis points; 100 bps = 1%. Fee cap is 300 bps. |
| **Fee collector** | Contract/address receiving the protocol fee. |
| **Native token sentinel** | `0xEeee…EEeE`, the pseudo-address representing native ETH (output only). |
| **Execution lane** | Backend config selecting the router generation (`owned_v1`, `owned_v2` [→V3 when configured], `basket_aggregator`). |
| **Best-effort execution** | V3 behavior: failed legs are skipped and refunded instead of reverting the sweep. |
| **Rescue functions** | Owner-only recovery of accidentally stuck funds; cannot touch funds inside a user's transaction. |

---

## Appendix A — Diagram Blueprints

Source material for the visual documentation set. Each blueprint lists nodes and edges so it can be rendered directly (Mermaid or design tool).

**A.1 System architecture diagram.** Nodes: Browser (`/dustsweep` UI + `useDustSweep`), Next.js API proxy, Hono backend API, Postgres (whitelist/caches/sweeps), Alchemy (discovery+RPC), DexScreener/CoinGecko (prices), 0x API (optional quotes), Wallet, Base chain {DustSwapSweepRouter V3, Permit2, allowlisted DEX routers ×9, FeeCollector}. Edges: UI→proxy→API for `/tokens`, `/quote`, `/build-tx`, `/record-sweep`; API→data sources; UI→Wallet (sign/sendCalls/sendTransaction); Wallet→Router; Router→Permit2 (pull), Router→DEXes (swaps), Router→FeeCollector (fee), Router→User (net output + refunds).

**A.2 DustSweep transaction flow (sequence diagram).** Lanes: User, Frontend, Backend, Wallet, Router, Permit2, DEX, FeeCollector. Sequence: scan → select → quote (re-check balances, fan-out quotes, best-per-token) → build-tx (allowlist checks) → [route-dependent: approvals batch / Permit2 sign + rebuild] → submit → router pulls exact inputs → per-leg approve-swap-reset loop with try/catch skip → refund leftovers → fee → net output → record-sweep.

**A.3 User flow diagram.** Connect → detect (capabilities ∥ delegation) → scan balances → pick tokens → pick output → preview quote → (price-impact confirm?) → route-aware stepper (batch: Confirm batch→Done; permit2: [Setup→]Sign→Sweep→Done; standard: Approve→Sweep→Done) → success modal / mapped error → rescan.

**A.4 Permit2 signing flow.** User → build-tx → typed data {domain: Permit2/8453; permitted[]; spender=router; nonce; deadline; witness{routeHash,outputToken,recipient,minAmountOut,deadline,feeBps}} → wallet `signTypedData` → signature → backend encodes `sweep(Permit2Signature,…)` → on-chain: router recomputes witness → Permit2 verifies signature + nonce + deadline → exact transfers in.

**A.5 EIP-5792 / EIP-7702 wallet compatibility flow (decision tree).** Start: connect + switch to Base. Branch 1: `eth_getCode` → delegated? → known foreign one-click delegate? → **switch_or_permit2**. Branch 2: own delegate (TokenPocket special-case) → **batch**. Branch 3: undelegated/own delegate AND `wallet_getCapabilities` atomic ∈ {ready, supported} → **batch**. Else → **permit2**. Footnote edges: batch failure at runtime → downgrade ladder (bundled approvals→sweep → sequential approvals → permit2-style standard sweep); blocked only if no EIP-712 support.

**A.6 Route execution flow (on-chain, V3).** sweep() → resolve fee → validate params/routes (allowlist) → snapshot inputs+output → pull inputs (mode switch: Permit2 witness / transferFrom) → loop per route: held-balance guard → approve exact → [Permit2 transient approval if UR] → `target.call(data)` → reset approvals → success ? RouteExecuted : RouteSkipped → refund leftover inputs (best-effort, RefundFailed tolerated) → output delta ≥ minAmountOut ? → fee → [unwrap WETH if native] → transfer net → DustSwept.

---

*Document generated from repository analysis. All "TODO" and "Needs confirmation" markers must be resolved by the team before this specification is published to GitBook.*
