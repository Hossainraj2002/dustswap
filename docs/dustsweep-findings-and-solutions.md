# DustSweep — A‑to‑Z Findings & Solution Plan

**Scope:** the `/dustsweep` sweep flow inside the DustSwap monorepo (`apps/web`, `packages/contracts`).
**Status of this document:** analysis + solution design only. No code changes were made. Nothing in the app was touched.
**Goal of the work it describes:** make the 50‑token, two‑transaction sweep work smoothly on every wallet that genuinely supports EIP‑5792 + EIP‑7702 batching, fix the three live bugs (TokenPocket gas estimation, OKX connection, MetaMask batching), and tighten the wallet gate — **without breaking the parts that already work (Coinbase Wallet, OKX extension) or any other surface of the app.**

---

## 1. Executive summary (read this first)

There is **one root cause** sitting underneath all three wallet bugs, and a few independent issues stacked on top of it.

**The root cause.** Your live sweep model is *"N on‑chain ERC‑20 approvals (one per token), bundled into a single wallet request via EIP‑5792, then one sweep transaction."* The bundling step depends entirely on each wallet's EIP‑5792/7702 implementation being able to **simulate and gas‑estimate the whole bundle**. That implementation is new, inconsistent between wallets, and on several wallets it is buggy. So the moment you exceed one token, you are at the mercy of the weakest part of each wallet. That is exactly the symptom you are seeing.

**Critical technical fact that explains TokenPocket.** The per‑call `gas` field your code attaches to each call inside `wallet_sendCalls` (`useDustSweep.ts`, `sendTokenPocketBatchApprovals`, the `gas: toRpcQuantity(APPROVAL_CALL_GAS_LIMIT)` line) was **removed from the EIP‑5792 specification**. It is not a standard field, wallets are free to ignore it, and TokenPocket does ignore it — it runs its own simulation of the bundle and that simulation is what fails with *"Contract error, cannot estimate gas limit."* There is **no client‑side flag that forces a wallet to skip its own estimation.** So the current TokenPocket workaround cannot work in principle, not just in practice.

**The three bugs, one line each:**

1. **TokenPocket** — its EIP‑5792/7702 batch simulator fails to estimate gas on a multi‑call bundle; the per‑call `gas` hint you pass is non‑standard and ignored. Fix path: stop trying to force a bundle through TokenPocket; use the real Permit2 signature flow (one signature, no per‑token approvals) and fall back to sequential explicit‑gas approvals only when Permit2 isn't possible.
2. **OKX mobile app** — this is a *connection* problem in the Privy + WalletConnect layer (not the sweep). Two separate failures are mixed together: a first‑load blur/stuck modal, and a Privy↔wagmi active‑wallet desync ("connected" in Privy but `walletClient` is null, so the sweep says "connect a wallet first"). The OKX **extension** works because it's injected; the **app** depends on WalletConnect/deeplink, which is where it breaks.
3. **MetaMask** — MetaMask *does* support EIP‑5792 atomic batch on Base, but it refuses to batch in three specific situations, the most likely one here being: **the address has already been delegated (EIP‑7702) to a non‑MetaMask smart account** (e.g. from a previous OKX/TokenPocket "upgrade" on the same wallet). MetaMask will not batch on an account already delegated elsewhere, so it silently falls back and "batch doesn't work."

**The strategic recommendation.** Stop maintaining a hand‑written brand allowlist as the source of truth, and stop forcing per‑token approval bundles. Instead:

- **Gate on capability, not brand.** You already call `wallet_getCapabilities` and compute an `atomicStatus` — but the actual gate (`useWalletWhitelist.ts`) ignores it and lets in any wallet that merely *has* `signTypedData`. Make the gate honor the real atomic status. Use the brand list only for ordering/labels/known‑bad warnings.
- **Adopt the true Permit2 signature flow** (your V2 contract already implements `sweepWithPermit2`). This collapses "N approvals + 1 sweep" into "**1 signature + 1 sweep**" for any token already approved to Permit2, and turns first‑time approvals into a clean, separately‑estimable step. It is the single highest‑leverage change and it makes the wallet differences mostly disappear.

Everything below is the detailed version of these points, plus the wallet matrix, the EIP background you asked for, and a prioritized plan with guardrails.

---

## 2. What DustSweep is (confirming I understood the goal)

DustSweep is a **dust aggregator on Base**: it finds the many tiny token balances ("dust") in a wallet and consolidates them into one useful asset (USDC in your screenshots) in **two user actions**:

- **Action 1 — batch approval** for up to 50 tokens at once.
- **Action 2 — batch sweep** that swaps all of them into the output token in one transaction.

The mechanism you chose to make "up to 50 in two clicks" possible is **batched/bundled transactions via EIP‑5792 (`wallet_sendCalls`) on top of EIP‑7702 (EOA → temporary smart account)**. Your stated constraint is correct: *without* a wallet that supports this batching, the "two clicks for 50 tokens" promise is not physically possible on an EOA — a plain EOA must send one transaction per approval. So the product genuinely depends on wallet batch support, and the central engineering question is **"which wallets really support it, and how do we behave when they don't?"**

Current reality from your report and the code:

- **Works:** Coinbase Wallet, OKX **extension**.
- **Broken:** TokenPocket (gas estimation), OKX **app** (connection), MetaMask (batching).

---

## 3. How the system actually works today (the parts that matter)

This section is the map you'll need before any fix makes sense. File references are to `apps/web/src`.

### 3.1 Connection layer — Privy + wagmi
- `app/providers.tsx` wraps the app in `PrivyProvider` → `@privy-io/wagmi` `WagmiProvider`. WalletConnect project id is read from env with a hardcoded fallback (`6f242331…`). Login method is wallet‑only, chains come from `config/web3.ts`.
- `hooks/useWalletConnection.tsx` holds two wallet lists (`PRIVY_WALLET_LIST`, `DUST_SWEEP_PRIVY_WALLET_LIST`) and a `getRuntimeWalletList()` that reorders/filters them by runtime (mobile vs desktop, OKX in‑app browser, TokenPocket in‑app browser). On connect success it calls Privy's `setActiveWallet`.
- `lib/ethereumProviders.ts` is the injected‑provider detective: it walks `window.ethereum`, `window.okxwallet`, `window.tokenpocket`, `ethereum.providers[]`, `ethereum.selectedProvider`, and uses `WeakSet`s + UA sniffing (`OKApp`, `TokenPocket`) to decide which injected object is OKX or TokenPocket.

### 3.2 The wallet "gate" — and why it isn't really gating
- `hooks/useWalletWhitelist.ts` is documented as *"capability‑based wallet support (~99% coverage)"* and it sets `isSupported` purely from: `typeof walletClient.signTypedData === "function" && typeof walletClient.sendTransaction === "function"`.
- **Almost every wallet has both methods.** So this gate effectively admits everyone. It does **not** check EIP‑5792 atomic batching at all. That is the disconnect with your stated goal ("only let wallets that support both EIPs in"): the gate's name says capability, but the capability it checks is unrelated to batching.

### 3.3 The capability detection — present but unused for gating
- `hooks/useDustSweep.ts` (the ~1,900‑line core) **does** detect real batch capability: in a `useEffect` it calls `wallet_getCapabilities` for the Base chain id and derives `atomicStatus` ∈ `{ready, supported, unsupported, unknown}` and `supportsWalletSendCalls`.
- `lib/dustsweep-wallets.ts` interprets the EIP‑5792 `atomic` capability correctly (`getAtomicStatus`, `getBatchCapabilityStatus`, `isBatchCapabilitySupported`). This is good, standards‑correct code.
- **But** this real signal drives only *execution strategy and notices*, not the *gate*. The gate (3.2) is the weaker, brand‑agnostic one. Result: a wallet that returns `atomic: unsupported` still passes the gate, enters the sweep, and fails later.

### 3.4 Execution strategies
`lib/dustsweep-wallets.ts` → `getExecutionStrategy()` maps each wallet to one of:
- `tokenpocket_existing` — TokenPocket‑specific path.
- `coinbase_paymaster` — Coinbase / Base Account (smart wallet + paymaster, split batch).
- `capability_gated_batch` — everyone else; uses `wallet_sendCalls` if `supportsWalletSendCalls`.

In `useDustSweep.ts` the executor then chooses between: one full bundle (`approvals + sweep` in a single `wallet_sendCalls`), approvals‑only bundle then a separate sweep, or fully sequential approvals + sweep — with an extensive cascade of try/catch fallbacks and user‑facing notices.

### 3.5 The contract layer (this is important and under‑used)
`packages/contracts/src/DustSweepPermit2RouterV2.sol` exposes **two** ways to pull tokens:
- `sweepWithPermit2(routes, outputToken, receiver, minAmountOut, deadline, permit, signature)` → pulls via `permit2.permitWitnessTransferFrom(...)`. This is the **signature‑based** path: the user approves the canonical **Permit2** contract once per token (reusable across all dapps forever), then authorizes a specific batch transfer with a **single off‑chain signature** — no per‑token on‑chain approval to your router at all.
- `sweepWithAllowance(routes, …)` → pulls via plain `IERC20.safeTransferFrom(msg.sender, …)`. This is the **allowance‑based** path: it requires a normal ERC‑20 `approve(router, amount)` for **each** token.

**What your live app is actually doing:** the front end sets `approvalSpender = buildTx.approvalSpender || DUST_SWEEP_ROUTER_V2_ADDRESS` and builds `approve(router, exactAmount)` calls. Your TokenPocket screenshot confirms it — four "DAI Transfer Authorization" entries approving the router `0x6d3C…E1E3` (which equals `NEXT_PUBLIC_DUST_SWEEP_ROUTER_V2_ADDRESS`) for exact amounts. **So you are on the allowance path, paying the full "N approvals" cost, even though the contract already supports the far cheaper Permit2 signature path.** This is the biggest missed lever in the codebase.

---

## 4. The single insight that ties the bugs together

> Bundling N approvals through a wallet is only as reliable as that wallet's brand‑new EIP‑5792/7702 simulator. You are exposing the weakest link of every wallet on the most fragile possible operation.

EIP‑7702 batching works by temporarily turning the EOA into a smart account and executing all calls through a delegate contract in one transaction. To show a fee and let the user confirm, the wallet must **simulate the entire delegated batch and estimate its gas**. Wallets do this very differently:

- Coinbase/Base Account are smart wallets by design → estimation is native and reliable (**why Coinbase works for you**).
- MetaMask implemented it well but added guard rails (refuses some accounts/states).
- TokenPocket's simulator currently throws on multi‑call bundles (**your bug #1**).

And the EIP‑5792 spec deliberately gives you **no escape hatch** to hand the wallet a gas number and skip its simulation (see §8.3). So "pass explicit gas so the wallet doesn't estimate" is structurally impossible through `wallet_sendCalls`.

The way out is to **stop needing N approvals**. That's what Permit2 is for, and your contract already supports it.

---

## 5. Bug #1 — TokenPocket "Contract error, cannot estimate gas limit"

### 5.1 What the screenshot is telling us
The TokenPocket sheet says *"Transaction Details (4) … This signature includes 4 authorization transactions"*, lists four `approve(router, exactAmount)` calls, shows a nonsense fee (`0.00000000488 ETH`, "Est. $0 ~ max $0"), and then errors with **"Contract error, cannot estimate gas limit."** That is TokenPocket receiving your `wallet_sendCalls` bundle, trying to build a single EIP‑7702 batch transaction, **simulating it to estimate gas, and the simulation failing.**

### 5.2 Why it fails (root cause, in order of likelihood)
1. **The per‑call `gas` hint is non‑standard and ignored.** Your `sendTokenPocketBatchApprovals` sets `gas: toRpcQuantity(APPROVAL_CALL_GAS_LIMIT)` on each call "so TP uses it without estimating." But the per‑call gas field **was removed from EIP‑5792** (it's incompatible with ERC‑4337, where there's one gas limit for the whole user op). TokenPocket ignores it and estimates anyway. *The comment in the code describes behavior the spec does not provide.*
2. **TokenPocket's 7702 batch simulator is buggy on multi‑call bundles.** Approvals individually never revert, so a healthy estimator would not fail. A failure here points at TP's bundling/delegation simulation, not at your calldata. This matches the symptom (works at 1 token, fails at >1).
3. **Possible network mismatch — worth verifying.** The sheet labels the payer "(POL‑1)". DustSweep is Base‑only (`chainId 8453`), and your `wallet_sendCalls` sets `chainId: 0x2105` (Base). If TokenPocket's active network is not Base while it simulates, an `approve()` to the Base router/token address on the wrong chain would hit a non‑matching contract and *legitimately* fail to estimate. The ETH‑denominated fee is consistent with Base, so this may just be a TP label quirk — but it's a five‑minute thing to confirm and would be a clean, separate cause if true.

### 5.3 Why the current code can't fix it
The executor's flow for TokenPocket is: full bundle (atomicRequired true) → retry compatible (atomicRequired false) → `TOKENPOCKET_BATCH_FAILURE_MESSAGE` → maybe sequential. Every branch that uses `wallet_sendCalls` hands TP a bundle it can't estimate, and the only branch that *does* work (sequential `eth_sendTransaction` with explicit gas via `sendTokenPocketRawTransaction`) is the "one‑by‑one" path you explicitly don't want. Also note: `TOKENPOCKET_BATCH_APPROVALS_ENABLED` is **defined but never read** — dead code; the batch path runs unconditionally for TP.

### 5.4 The fix (keeps the 2‑action promise, removes the estimation dependency)
Reframe the goal: the user wants **two actions**, not necessarily two `wallet_sendCalls`. Permit2 gives you two actions *without* asking TokenPocket to simulate a batch:

1. **Switch TokenPocket (and ideally everyone) to the Permit2 signature path** (`approvalSpender = Permit2`, sweep via `sweepWithPermit2`). For every token already approved to Permit2, there are **zero** on‑chain approvals — the "approval" becomes **one off‑chain signature** (`PermitBatchWitnessTransferFrom`) covering up to 50 tokens. TokenPocket signs typed data fine; no gas estimation involved.
2. **For tokens not yet approved to Permit2**, you still need an `approve(Permit2, max)` per token the first time. Send those **sequentially with explicit gas** through the path that already works on TP (`sendTokenPocketRawTransaction` + your `publicClient.estimateGas` pre‑estimate). These approvals are one‑time per token *ever* (reused across all dapps), so most returning users skip them entirely. This is the one place a brief sequential step is acceptable — it shrinks over time and never blocks the sweep itself.
3. **Then one sweep transaction.** You already pre‑estimate the sweep via your own RPC and pass explicit gas for TP, which is why the single sweep tx estimates fine.

Net result for TokenPocket: **1 signature + 1 sweep** in the common case; a shrinking, one‑time, per‑token Permit2 approval the first time. No reliance on TP's broken bundle simulator. If you want to keep a pure on‑chain story, the honorable fallback is sequential explicit‑gas approvals — still robust, just more clicks — but Permit2 makes that rare.

> If TokenPocket's batch simulator must be used (e.g. for the one‑time Permit2 approvals as a single prompt), treat success as best‑effort and **always** fall back to sequential on the "cannot estimate gas" error — which `isBatchFallbackError()` already classifies. Do not surface the raw TP error to users.

---

## 6. Bug #2 — OKX **app** won't connect (Privy + WalletConnect)

This is a **connection** bug, separate from the sweep. The OKX **extension** is injected (so it's detected and works); the OKX **app** on mobile must connect over WalletConnect / deeplink, which is where it breaks. There are actually two distinct failures in your description.

### 6.1 Failure A — first‑load "blur screen stuck"
On first visit the page shows the DustSweep logo blurred behind a white sheet and is stuck until you tap. That's the Privy/connect modal (or its backdrop) mounting before it has focus/state, over a `backdrop-blur` background. Likely contributors:
- SSR/hydration timing with `@privy-io/wagmi` `reconnectOnMount` — the modal/backdrop renders before Privy is ready.
- A `backdrop-blur` overlay that captures pointer events while empty.

Fix direction: gate the connect UI on Privy's `ready` state before rendering the backdrop; ensure the overlay is not interactive until the modal has content; verify the modal mounts inside a focus‑trapped portal. This is a front‑end lifecycle fix, low risk.

### 6.2 Failure B — "Waiting for OKX Wallet… Please try connecting again"
This is the WalletConnect handshake to the OKX app not completing. Root causes to check, in order:
1. **WalletConnect project id.** `providers.tsx` falls back to a hardcoded `walletConnectCloudProjectId` and there are **three different** env names floating around (`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, `…_WALLET_CONNECT_PROJECT_ID`, `…_WC_PROJECT_ID`) with **different values in `.env` vs `.env.local`**. If the id used at runtime isn't a valid/active Reown (WalletConnect Cloud) project with your domain allow‑listed, OKX‑app relays fail intermittently — which matches "sometimes connects, sometimes "try again."" **Consolidate to one id, confirm it's live, and add `app.dustswap.wtf` to its allowed domains.**
2. **Mobile runtime wallet list.** Privy's `detected_ethereum_wallets` is **empty in a normal mobile browser** (injection only happens inside a wallet's own in‑app browser). Your `getRuntimeWalletList()` already prioritizes `okx_wallet` on mobile when an OKX runtime is detected — good — but in a plain mobile browser (your screenshots, with VPN) it must rely on the `okx_wallet` connector's WalletConnect deeplink. Make sure that on non‑OKX mobile browsers the list keeps `okx_wallet` (the WalletConnect‑backed entry) and doesn't get reduced to only `detected_ethereum_wallets`.
3. **OKX in‑app browser path.** When the UA is `OKApp`, your code drops `okx_wallet` and keeps only `detected_ethereum_wallets` (correct — inside OKX, OKX is injected). Verify the injected provider is actually found there; if the connect succeeds but the sweep later says "connect first," that's Failure C.

### 6.3 Failure C — "auto‑connects, but sweep says 'Connect a wallet first'"
This is the highest‑value clue. It means **Privy thinks a wallet is connected but wagmi's `walletClient` is null.** Your sweep needs `walletClient` (from wagmi's `useWalletClient()`), while the gate/labels read Privy's `activeWallet`. When OKX connects through Privy but `setActiveWallet(...)` doesn't propagate the connector into the wagmi config, you get exactly this split‑brain: connected in one system, absent in the other.

Fix direction:
- In `useWalletConnection.tsx`, the `onSuccess` handler calls `setActiveWallet` — confirm it runs for the OKX connector and that the connector is registered in the wagmi config Privy is using. Await/verify activation before treating the wallet as ready.
- In the sweep gate, derive "connected" from the **same** source the executor uses (`useAccount()` / `useWalletClient()` from wagmi), not from Privy's `activeWallet`, so the gate and the executor never disagree.
- Add a small reconciliation: if Privy reports connected but `walletClient` is null after a tick, re‑activate or prompt reconnect, instead of showing a dead "connect first" state.

OKX **extension** avoids all of this because it's injected and wagmi picks it up directly — which is why it already works.

---

## 7. Bug #3 — MetaMask batch approve/sweep not working

MetaMask **does** support EIP‑5792 atomic batch **on Base mainnet** (confirmed in MetaMask's current docs — Base is in their supported‑networks list, via EIP‑7702 "smart account" upgrade). So the capability exists; something is preventing it in your flow. The likely causes, most probable first:

1. **The account is already delegated to a non‑MetaMask smart account.** MetaMask's docs state plainly: *"If the user has already upgraded their account to a third‑party smart contract account, MetaMask does not currently support atomic batch transactions for that account."* If a tester used OKX's or TokenPocket's 7702 "upgrade" on the **same address**, MetaMask will return no `atomic` capability for it and refuse to batch. This is the classic "MetaMask batch silently doesn't work" cause and it's very easy to hit while testing multiple wallets on one seed phrase. **Verify with a fresh, never‑delegated address.**
2. **Network mismatch.** MetaMask requires the `chainId` in `wallet_sendCalls` to **match the currently selected network**. If `switchToBase` hasn't fully applied when the bundle is sent, MetaMask errors and you fall back. Ensure the chain switch is awaited and confirmed before sending calls.
3. **Capability detection returning nothing → silent fallback.** MetaMask returns the `atomic` capability **only** when it's `ready` or `supported`; otherwise it returns nothing for that chain. If your `wallet_getCapabilities` probe doesn't see it (wrong params shape, called before the wallet is on Base, or a wrapper client that doesn't forward the method), `supportsWalletSendCalls` is false, `canUseAtomicBatch` is false, and the code goes straight to sequential Permit2/standard approvals — i.e. "batch isn't working," but quietly. Your probe tries both `[address,[chainId]]` and `[address]`, which is good; confirm it runs **after** the wallet is on Base and against the injected MetaMask provider specifically.
4. **Not a capability problem in your code:** your `gasLimitOverride` capability is correctly marked `optional: true`, so MetaMask will ignore it rather than reject the batch. (Sending an *unknown, non‑optional* capability would trigger a `5700`‑class rejection — you've avoided that. Keep it that way.)

Fix direction: (a) test on a clean address to rule out prior delegation; (b) make the capability probe + chain‑switch ordering deterministic (switch to Base → confirm → probe → only then offer batch); (c) when MetaMask reports `atomic: ready`, expect and handle the one‑time "upgrade to smart account" prompt; (d) once on the Permit2 signature flow, MetaMask's batch is only needed for first‑time Permit2 approvals, which dramatically shrinks the surface where this bug can bite.

---

## 8. Deep dive — EIP‑5792 & EIP‑7702 (the background you asked for)

### 8.1 EIP‑7702 — "your EOA can act as a smart account for one transaction"
Shipped in Ethereum's **Pectra** upgrade (2025). It lets an EOA include an **authorization** that points its account at a **delegate contract's** code for the duration of a transaction. That delegate can do smart‑account things — most importantly **execute several calls in one transaction**. This is what makes "approve 4 tokens + sweep, in one tx" possible from a normal wallet address. The wallet manages the delegate and the authorization; your dapp never sees the 7702 plumbing directly.

### 8.2 EIP‑5792 — the dapp‑facing API
Three methods:
- **`wallet_getCapabilities(address, [chainIds])`** — ask what the wallet can do. The relevant capability is **`atomic`**, whose `status` is:
  - **`supported`** — wallet will execute all calls atomically and contiguously right now.
  - **`ready`** — wallet *can* upgrade (via 7702) pending a one‑time user approval; after approval it becomes `supported`.
  - **`unsupported`** — no atomicity guarantees.
- **`wallet_sendCalls({version:"2.0.0", from, chainId, atomicRequired, calls[], capabilities})`** — submit the batch; returns a batch **id**.
- **`wallet_getCallsStatus(id)`** — poll for status (200 = confirmed) and receipts.

Your code implements all three correctly, including the `atomic` status interpretation and `atomicRequired`. The gap isn't the API usage — it's (a) not gating on the result and (b) leaning on the batch for something Permit2 should do.

### 8.3 The gas‑estimation reality (the crux of bug #1)
- EIP‑5792's **early drafts had a per‑call `gas` field; it was deliberately removed** because ERC‑4337 accounts have a single gas limit for the whole user operation, not per call. So there is **no standard way to tell a wallet "use this gas, don't estimate."**
- The spec also says a wallet **MAY reject the batch if any call is expected to fail when simulated.** Wallets therefore **must** simulate/estimate the bundle to show a fee and confirm. If a wallet's simulator is buggy (TokenPocket) or guarded (MetaMask on a delegated account), the batch dies *before* the user can confirm.
- Consequence: **you cannot engineer around a wallet's bad batch estimator from the dapp side.** You can only (1) detect it and route around it, or (2) reduce how often you need the batch at all. Permit2 does (2).

### 8.4 Why Permit2 changes the math
Permit2 (canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`) is a singleton that holds approvals and executes **signature‑authorized batch transfers**. With it:
- Approve Permit2 **once per token, ever** (reusable across every dapp that uses Permit2 — many users already have these from Uniswap, etc.).
- Then authorize any specific batch transfer with **one EIP‑712 signature** — free, off‑chain, no gas estimation, no 7702 needed.
- Your router's `sweepWithPermit2` already consumes exactly this. So the "approval for 50 tokens" becomes **one signature**, and the only on‑chain transaction is the sweep.

This is why moving onto the Permit2 path is the highest‑leverage fix: it removes the per‑token approval bundle — the exact thing every wallet is choking on — for the common (returning‑user) case, and isolates first‑time approvals into a clean, individually‑estimable step.

---

## 9. Wallet support matrix & how to gate correctly

### 9.1 The matrix (Base mainnet, mid‑2026)
"Batch" = EIP‑5792 `wallet_sendCalls` with `atomic` `ready`/`supported`. Confidence reflects how strongly current public sources confirm it; **runtime `wallet_getCapabilities` is the real source of truth** — treat this table as priors for ordering/labels, not as the gate.

| Wallet | Injected (ext) | Mobile path | EIP‑5792 batch on Base | Notes / caveats |
|---|---|---|---|---|
| Coinbase Wallet / Base Account | ✅ | in‑app + WC | ✅ native smart wallet | Already working for you; paymaster path. |
| OKX (extension) | ✅ | — | ✅ | Already working for you. |
| OKX (mobile app) | — | WC / in‑app browser | ✅ (capability ok) | Your bug is **connection**, not batch. |
| MetaMask (v12+) | ✅ | WC / in‑app | ✅ via 7702 smart account | Refuses batch if address already delegated elsewhere; needs network match + one‑time upgrade prompt. |
| Rabby | ✅ | in‑app | ⚠️ 7702 shipped late‑2025; batch via capabilities | Verify `atomic` at runtime; code already has a Rabby fallback notice. |
| Ambire | ✅ | in‑app | ✅ 7702 from day one | Strong AA support; good candidate to add. |
| Trust Wallet | ✅ | WC / in‑app | ⚠️ signs/display 7702; batch maturing | Verify at runtime before promising one‑click. |
| Rainbow | ✅ | WC / in‑app | ⚠️/✅ reported 5792 support | Verify at runtime. |
| TokenPocket | ✅ | in‑app | ❌ today (estimator fails on bundles) | Use Permit2 signature path; sequential fallback for first‑time approvals. |
| Zerion / Bitget / Phantom (EVM) / Uniswap / Crypto.com | ✅ | varies | ❓ verify at runtime | Keep in list; let capability probe decide. |

**Takeaway on your allowlist question:** you cannot keep a perfect static list — support changes month to month and depends on the *user's account state* (e.g. prior delegation), not just the brand. So don't try. **Detect at runtime and gate on the answer.**

### 9.2 How to gate correctly (the actual change to `useWalletWhitelist.ts`)
Today the gate admits any wallet with `signTypedData`. Replace the *meaning* of the gate with a three‑tier model driven by the **real** `atomicStatus` you already compute in `useDustSweep.ts`:

- **Tier 1 — one‑click batch:** `atomic` is `supported` or `ready` → offer the full batched experience (or, on the Permit2 path, signature + sweep).
- **Tier 2 — supported via Permit2, no atomic batch:** wallet can `signTypedData` but `atomic` is `unsupported` → still fully usable through Permit2 (1 signature + 1 sweep + one‑time per‑token Permit2 approvals done sequentially). This is the key realization: **lack of EIP‑5792 does not have to block the product once you use Permit2.**
- **Blocked:** can't sign typed data at all → genuinely unsupported; show the gate message.

This both **honors your "only proper wallets" intent for the premium one‑click path** and **widens real coverage** (Permit2 makes most wallets work even without 5792). Wire the gate to the capability signal that already exists rather than the brand‑agnostic stub.

> Important: make the capability probe authoritative and timed correctly (after connect, after switch‑to‑Base). A flaky probe that returns `unknown` should degrade to "verify on action," not to a hard block — otherwise you'll accidentally lock out good wallets, the opposite of the current over‑permissive bug.

---

## 10. Recommended target architecture (the "to‑z")

Adopt **Permit2 as the primary flow**, with EIP‑5792 batching as an enhancement for first‑time approvals, and capability‑gated tiers for UX. Conceptually:

1. **Detect** (on connect, on Base): `wallet_getCapabilities` → `atomicStatus`. Record tier.
2. **Quote**: backend returns routes + the Permit2 witness permit to sign (`buildPermit2WitnessTypedData` already exists) + `approvalSpender = Permit2`.
3. **Check Permit2 allowances** for the selected tokens.
   - **All tokens already approved to Permit2** → **Action 1 = one signature** (`PermitBatchWitnessTransferFrom`), **Action 2 = `sweepWithPermit2`**. This is the dream path and it works on essentially every wallet, batch‑capable or not.
   - **Some tokens not yet approved to Permit2** → do those `approve(Permit2, max)` first:
     - Tier 1 (atomic `supported`/`ready`): bundle them via `wallet_sendCalls` (one prompt). On any estimation/atomicity error, fall back to sequential automatically.
     - Tier 2 (no atomic): sequential `approve` with explicit gas (the path that already works on TP). One‑time per token, ever.
   - Then the signature + `sweepWithPermit2`.
4. **Execute & confirm**: poll `wallet_getCallsStatus` for bundles, `eth_getTransactionReceipt` for single txs (your code already branches on this).

Why this is the right shape:
- It **preserves the "two actions" promise** (sign + sweep) for returning users and most first‑timers.
- It **removes the dependency** on each wallet's batch estimator for the sweep itself.
- It **keeps everything that works** (Coinbase paymaster path, OKX extension) — those wallets just get the Permit2 flow too, or keep their current atomic batch where it's better. Nothing is removed.
- It is **incremental**: the contract already supports `sweepWithPermit2`; the typed‑data builders already exist (`lib/permit2.ts`); the calldata encoder already exists (`encodeDustSweepV2Calldata`). You are wiring up code that's mostly written, not inventing a new system.

> One correctness item to confirm during implementation: today `approvalSpender` resolves to the **router**, but `sweepWithPermit2` pulls via **Permit2**. If you move to the signature path, the approval target must be **Permit2**, and the sweep must call `sweepWithPermit2` (not `sweepWithAllowance`). Mixing them (approve router, pull via Permit2) would fail because Permit2 would have no allowance. Make sure backend `buildTx.approvalSpender` and the chosen sweep function always agree.

---

## 11. UI/UX findings

- **The wallet gate lies about why.** Because the gate admits everyone (§3.2), users on truly unsupported wallets get through and hit a cryptic failure mid‑sweep instead of an honest, upfront message. Move the truth forward: show tier at connect time ("One‑click batch ✓" / "Supported via Permit2 — 1 signature + 1 sweep" / "Not supported — try X"). This is both better UX and exactly your "only let supported wallets in" intent, done kindly.
- **Surface state, not jargon.** Strings like `TOKENPOCKET_BATCH_FAILURE_MESSAGE` and raw "cannot estimate gas" leak wallet internals. Map every failure class to a plain next‑step ("This wallet couldn't batch — we'll do it in two quick steps instead," with the app continuing automatically).
- **First‑load blur/stuck (OKX §6.1)** is a general polish bug, not OKX‑specific — fix the modal/backdrop lifecycle for all wallets.
- **Progress clarity.** With Permit2 the flow becomes "Sign → Sweep." Make those two steps explicit and show which tokens (if any) need a one‑time Permit2 approval before the signature, so the occasional extra approval doesn't feel like a failure.
- **Network state.** Show "Switch to Base" proactively and confirm the switch before enabling Sweep — this prevents the MetaMask/TokenPocket wrong‑network estimation failures (§6.2, §7).
- **Receiver address & amounts** are already clear in the sweep card (good). Keep the explicit "to" address and per‑token list — it builds trust on a screen that asks for blanket transfer authority.

---

## 12. Prioritized roadmap (with "don't break anything" guardrails)

Ordered by leverage ÷ risk. Each item names the files most likely involved so the change stays surgical.

**P0 — make the gate honest (low risk, high clarity)**
- Wire `useWalletWhitelist.ts` to the real `atomicStatus`/`supportsWalletSendCalls` already computed in `useDustSweep.ts`; introduce the three tiers (§9.2). Don't remove the `signTypedData` check — *add* the capability tier on top so nothing currently allowed is suddenly blocked except genuinely unsupported wallets.
- Guardrail: ship behind a flag; default the "blocked" tier to **warn, not block** until you've confirmed the probe is reliable in production.

**P0 — verify the three bug hypotheses cheaply (no code)**
- TokenPocket: confirm active network is Base during the failing batch (§5.2.3).
- MetaMask: retry on a **fresh, never‑delegated** address (§7.1).
- OKX: confirm which WalletConnect project id is live at runtime and whether the domain is allow‑listed (§6.2.1).

**P1 — adopt the Permit2 signature flow (high leverage)**
- Backend: return `approvalSpender = Permit2`, the witness permit, and ensure the sweep builds `sweepWithPermit2` calldata (`encodeDustSweepV2Calldata` exists). Front end: branch on Permit2 allowance presence (§10).
- Guardrail: keep the existing allowance path (`sweepWithAllowance`) as a fallback lane behind `NEXT_PUBLIC_DUST_SWEEP_EXECUTION_LANE` so you can revert instantly. Roll out to one wallet (e.g. MetaMask) first, then widen.

**P1 — fix OKX connection (isolated to connection layer)**
- Consolidate the WalletConnect id to one env var; fix Privy↔wagmi active‑wallet desync (§6.3); fix first‑load modal lifecycle (§6.1).
- Guardrail: connection‑layer only — does not touch sweep execution, so it can't regress Coinbase/OKX‑extension sweeps.

**P2 — TokenPocket polish & cleanup**
- Remove dead `TOKENPOCKET_BATCH_APPROVALS_ENABLED`; drop the non‑standard per‑call `gas` hint comment/claim; route TP through Permit2 + sequential first‑time approvals; make all TP errors degrade silently to the working path.

**P2 — widen the wallet matrix by capability**
- Add Ambire/Rabby/Trust/Rainbow/Zerion to the Privy list (most already there) and let the runtime probe decide their tier. No brand‑specific code beyond labels/ordering.

**P3 — hardening**
- Deterministic ordering everywhere: connect → switch to Base → probe capabilities → quote → execute.
- Telemetry on which tier/path each sweep used and where fallbacks trigger, so the matrix becomes data‑driven instead of guesswork.

**Global guardrails (apply to every change):**
- Touch only `apps/web/src` sweep/wallet files and backend `buildTx`; do **not** modify quests, spin, leaderboard, footprint, referrals, or swap surfaces.
- Every new path behind an env flag with the current behavior as default until verified.
- Keep `sweepWithAllowance` and the sequential approval paths as live fallbacks — they are your safety net and already work.
- Regression‑test the two flows that work today (Coinbase Wallet, OKX extension) **before and after** each change.

---

## 13. Things to verify (open questions)

1. **TokenPocket network** — is it really on Base (8453) when the batch is built? The "POL‑1" label needs a definitive check (§5.2.3).
2. **MetaMask account delegation** — were tests run on an address previously upgraded by another wallet? Re‑test clean (§7.1).
3. **WalletConnect project id** — which of the three env names is actually used at runtime, is the project active, and is `app.dustswap.wtf` an allowed domain? (§6.2.1)
4. **`approvalSpender` vs sweep function** — does the backend currently return the **router** as spender while the contract path expects **Permit2**? Confirm they agree per lane (§10).
5. **Privy↔wagmi sync for OKX** — does `setActiveWallet` register the OKX connector into the wagmi config the sweep reads? (§6.3)
6. **Capability probe timing** — is `wallet_getCapabilities` ever called before the wallet is on Base, yielding false "unsupported"? (§7.3)

---

## 14. Sources

EIP standards & mechanics:
- [EIP‑5792: Wallet Call API (spec)](https://eips.ethereum.org/EIPS/eip-5792)
- [EIP‑5792 — `wallet_sendCalls` reference](https://www.eip5792.xyz/reference/sendCalls) and [`atomic` capability](https://www.eip5792.xyz/capabilities/atomic)
- [Viem — getCapabilities (EIP‑5792)](https://viem.sh/experimental/eip5792/getCapabilities)
- [Base docs — `wallet_getCapabilities`](https://docs.base.org/base-account/reference/core/provider-rpc-methods/wallet_getCapabilities)
- [ERC‑7702 deep dive 2026](https://eco.com/support/en/articles/15254037-erc-7702-deep-dive-2026-eoa-becomes-smart-wallet) · [Alchemy: EIP‑7702 & wallets](https://www.alchemy.com/blog/eip-7702-metamask-and-wallets)

Wallet support:
- [MetaMask — Batch transactions with EIP‑5792](https://docs.metamask.io/metamask-connect/evm/guides/send-transactions/batch-transactions/) (Base supported; refuses batch on accounts already delegated elsewhere; chainId must match selected network)
- [MetaMask — EIP‑7702 quickstart](https://docs.metamask.io/smart-accounts-kit/get-started/smart-account-quickstart/eip7702/)
- [TokenPocket — EIP‑7702 introduction](https://help.tokenpocket.pro/en/wallet-operation/what-is-profit-and-loss/eip7702)
- [Ambire — EIP‑7702 wallet](https://blog.ambire.com/eip-7702-wallet/) · [OKX Research — EIP‑7702](https://web3.okx.com/learn/eip-sdk-implementation)
- [WalletConnect — EIP‑5792 UX](https://walletconnect.com/blog/eip-5792-the-ux-breakthrough-everyone-s-ignoring)

Connection layer:
- [Privy — configuring external connector wallets](https://docs.privy.io/wallets/connectors/setup/configuring-external-connector-wallets) (`detected_ethereum_wallets` empty on mobile except in‑app browsers; use named connectors + WalletConnect on mobile)
- [OKX — WalletConnect](https://walletconnect.com/explorer/okx-wallet) · [OKX — dApp connection prerequisites](https://web3.okx.com/build/dev-docs/sdks/app-connect-preparation)

Permit2:
- Canonical Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` (Uniswap Permit2), consumed by your `DustSweepPermit2RouterV2.sol` via `permitWitnessTransferFrom`.


