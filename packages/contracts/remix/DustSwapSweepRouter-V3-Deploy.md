# DustSweep V3 — `DustSwapSweepRouter` Deploy & Switch Guide (Base, chainId 8453)

This is a **brand-new** router. It does **not** touch V2
(`DustSweepPermit2RouterV2` @ `0x6d3C31E4a2b8e1Fe9De0d260D142183E82cbE1E3`) or any working app
code. Deploy it yourself from Remix, whitelist the DEXes, then flip the app with **one** env var.

- Canonical source: `packages/contracts/src/DustSwapSweepRouter.sol`
- Remix single file (deploy this): `packages/contracts/remix/DustSwapSweepRouter_Remix.sol`
- Tests: `packages/contracts/test/DustSwapSweepRouter.t.sol` (20/20 pass, fork-free)

---

## 1. What V3 adds over V2

| Capability | V2 | V3 (`DustSwapSweepRouter`) |
|---|---|---|
| Input pull modes | two functions | **one `sweep()` entrypoint** + `mode` flag (Permit2Signature / Allowance) |
| Partial failures | whole batch reverts | **best-effort**: failed legs are skipped + refunded, good legs settle |
| Output | ERC-20 only | ERC-20 **or native ETH** (WETH unwrap) |
| Fee | default only | default **+ per-sweep `feeBpsOverride`** (still hard-capped at 300 bps) |
| Fee in signature | not bound | **`feeBps` bound into the Permit2 witness** (user signs the fee) |
| Stuck funds | possible on revert paths | **never** — every unconsumed input is refunded |
| DEX coverage | Uni V3, Pancake, Aero classic, BaseSwap | + Uni **V4** (Universal Router), Aero **Universal Router + Slipstream**, **AlienBase**, **DackieSwap** |
| Caller | EOA / Permit2 | EOA, **EIP-7702 smart account, contract** (Permit2 EIP-1271) |

**Approval safety (unchanged guarantee, made stricter):** `route.amountIn` is the single source of
truth. Permit/approval == pulled == DEX approval == swap amount, and **every allowance returns to 0
after each route**. There is **no** infinite/standing-allowance path. Fee-on-transfer tokens that
would leave the router holding `< amountIn` are skipped + refunded, never over-approved.

---

## 2. EXACT Remix / BaseScan settings (use these, do not rely on defaults)

| Setting | Value |
|---|---|
| Compiler | **0.8.24** (`0.8.24+commit.e11b9ed9`) |
| Language | Solidity |
| EVM version | **cancun** (set it explicitly in Remix → Advanced Configurations; Base supports it) |
| Optimizer | **Enabled** |
| Optimizer runs | **200** |
| License | MIT |
| File | `DustSwapSweepRouter_Remix.sol` (flattened, zero external imports) |

> Verified: the flattened file compiles standalone with exactly these settings and **0 import
> statements**. Use the identical settings on BaseScan "Verify & Publish" (Single file, optimizer
> on / 200 runs, EVM cancun) for a first-try verification.

---

## 3. Constructor arguments (paste in this order)

`constructor(address _permit2, address _weth, address _owner, address _feeCollector, uint16 _feeBps)`

| # | Arg | Value to paste | Why |
|---|---|---|---|
| 1 | `_permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical Permit2 (same on every chain; verified live on Base). |
| 2 | `_weth` | `0x4200000000000000000000000000000000000006` | Base WETH; used to unwrap to native ETH on ETH-out sweeps. |
| 3 | `_owner` | **your owner / multisig address** | Gets config, pause, rescue. Use the same operator key as V2. |
| 4 | `_feeCollector` | **your fee collector address** (`DUST_SWEEP_FEE_COLLECTOR`) | Receives protocol fees. Must be non-zero if `_feeBps > 0`. |
| 5 | `_feeBps` | `60` | Default 0.60% fee (matches `DUST_SWEEP_FEE_BPS=60`). Must be `<= 300`. |

Constructor reverts if any of permit2/weth/owner is zero, if `_feeBps > 300`, or if `_feeBps > 0`
with a zero `_feeCollector`.

---

## 4. Owner-only whitelist calls to run AFTER deploy (do NOT send from this guide)

Run these from Remix (or BaseScan "Write Contract") as the **owner**. Targets = contracts the
router calls; Spenders = addresses that pull the input token. Universal Routers pull via Permit2,
so their spender is Permit2 (not the router).

### `setAllowedTarget(address,bool)` — call once per address with `true`

```
0x6fF5693b99212Da76ad316178A184AB56D299b43   # Uniswap Universal Router (V3+V4)
0x2626664c2603336E57B271c5C0b26F421741e481   # Uniswap V3 SwapRouter02
0x6Cb442acF35158D5eDa88fe602221b67B400Be3E   # Aerodrome Universal Router (classic + Slipstream)
0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43   # Aerodrome Classic Router (Solidly)
0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5   # Aerodrome Slipstream SwapRouter (CL)
0x1b81D678ffb9C0263b24A97847620C99d213eB14   # PancakeSwap SmartRouter (V2+V3+stable)
0xB20C411FC84FBB27e78608C24d0056D974ea9411   # AlienBase SmartRouter (V2+stable+V3)
0x195FBc5B8Fbd5Ac739C1BA57D4Ef6D5a704F34f7   # DackieSwap SmartRouter
0x327Df1E6de05895d2ab08513aaDD9313Fe505d86   # BaseSwap Router
```

### `setAllowedSpender(address,bool)` — call once per address with `true`

```
0x000000000022D473030F116dDEE9F6B43aC78BA3   # Permit2  (Uni UR + Uni V4 + Aerodrome UR pull through this)
0x2626664c2603336E57B271c5C0b26F421741e481   # Uniswap V3 SwapRouter02 (self-spender, plain approve)
0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43   # Aerodrome Classic Router (self)
0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5   # Aerodrome Slipstream SwapRouter (self)
0x1b81D678ffb9C0263b24A97847620C99d213eB14   # PancakeSwap SmartRouter (self)
0xB20C411FC84FBB27e78608C24d0056D974ea9411   # AlienBase SmartRouter (self)
0x195FBc5B8Fbd5Ac739C1BA57D4Ef6D5a704F34f7   # DackieSwap SmartRouter (self)
0x327Df1E6de05895d2ab08513aaDD9313Fe505d86   # BaseSwap Router (self)
```

> Add new DEXes later with the same two setters — **no redeploy**. Before whitelisting any address,
> do the final on-chain sanity check yourself (BaseScan label + recent volume). The router can never
> be bricked by a bad DEX address because no DEX address is hard-coded.

These same addresses are exported in code for the app builders:
`apps/api/src/config/dustsweepV3Sources.ts` → `getBaseDustSweepV3Allowlist()`.

---

## 5. Switch the app to V3 (single value, no fallback)

1. Deploy + verify V3, run the whitelist calls above.
2. Set **one** env value (server + browser), then redeploy the app:

   ```
   # apps/api/.env
   DUST_SWEEP_ROUTER_V3_ADDRESS=0xYourDeployedV3Address

   # apps/web/.env (browser)
   NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS=0xYourDeployedV3Address
   ```

3. The app reads it via `getDustSweepV3RouterAddress()` (API) /
   `DUST_SWEEP_ROUTER_V3_ADDRESS` (web `dustsweep-router-v3.ts`). Calldata is built with
   `encodeDustSweepV3Calldata({ mode, routes, params, permit, signature })`.

Wallet mode is unchanged and reused as-is: EIP-5792 wallets (detected via
`wallet_getCapabilities` in `dustsweep-wallets.ts`) batch `approve + sweep` →
`DustSweepV3Mode.Allowance`; plain EOAs → `DustSweepV3Mode.Permit2Signature`. Every wallet
permit/approval is built for **exactly** `route.amountIn` per token (never max), with short
deadlines.

There is **no V2/V3 fallback**: when the V3 address is set, the app talks only to V3.

---

## 6. Verified external addresses (Base 8453)

All confirmed live via `eth_getCode` on `https://mainnet.base.org` (2026-06-09) **and** the source
shown. ⚠️ flags a value that differs from the brief or from the current app config.

| Contract | Address | Verification |
|---|---|---|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical; live code (9,152 bytes). |
| WETH | `0x4200000000000000000000000000000000000006` | Base predeploy; live code. |
| Uniswap Universal Router (V3+V4) | `0x6fF5693b99212Da76ad316178A184AB56D299b43` | Uniswap official docs (Base v3 + v4 deployments); live code. ⚠️ The API env currently lists the **older** UR `0xfdf682f5…` — this is the newer V4-capable UR. |
| Uniswap V3 SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` | Uniswap official docs; live code; already used by V1/V2. |
| Uniswap V4 PoolManager | `0x498581fF718922c3f8E6A244956aF099B2652b2b` | Uniswap official docs (v4 Base); live code (reference only). |
| Uniswap V4 Quoter | `0x0d5e0F971ED27FBfF6c2837bf31316121532048D` | Uniswap official docs (v4 Base); live code (reference only). |
| Permit2 spender for Uni UR/V4 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Universal Router pulls via Permit2. |
| Aerodrome Universal Router | `0x6Cb442acF35158D5eDa88fe602221b67B400Be3E` | BaseScan verified label "Aerodrome: Universal Router" (5M+ txs); live code. |
| Aerodrome Classic Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` | Aerodrome docs/GitHub; live code; already used by V1/V2. |
| Aerodrome Slipstream SwapRouter | `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` | Aerodrome Slipstream docs; live code. |
| PancakeSwap SmartRouter | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` | PancakeSwap docs; live code; already used by V1/V2. |
| AlienBase SmartRouter | `0xB20C411FC84FBB27e78608C24d0056D974ea9411` | AlienBase docs; live code. |
| DackieSwap SmartRouter | `0x195FBc5B8Fbd5Ac739C1BA57D4Ef6D5a704F34f7` | DackieSwap docs; live code. |
| BaseSwap Router | `0x327Df1E6de05895d2ab08513aaDD9313Fe505d86` | BaseSwap docs; live code; already used by V1/V2. |

Sources: [Uniswap Base v3 deployments](https://developers.uniswap.org/contracts/v3/reference/deployments/base-deployments),
[Uniswap v4 deployments](https://developers.uniswap.org/contracts/v4/deployments),
[Aerodrome UR on BaseScan](https://basescan.org/address/0x6cb442acf35158d5eda88fe602221b67b400be3e),
[Aerodrome contracts](https://github.com/aerodrome-finance/contracts).

> Note on the spender model per DEX: **Permit2** for the two Universal Routers (Uniswap, Aerodrome);
> **self (plain ERC-20 approve)** for SwapRouter02, Aerodrome Classic + Slipstream, and the
> Pancake/AlienBase/Dackie/BaseSwap routers. Confirm each router's pull mechanism before relying on
> it in production; the contract approves exactly `amountIn` either way and resets to 0.

---

## 7. Build / test status

- `forge build` — passes (solc 0.8.24, optimizer 200, evm paris in repo profile; the flattened
  Remix file also compiles under evm **cancun**, which is what you deploy).
- `forge test --match-contract DustSwapSweepRouterTest` — **22/22 pass** (fork-free, pure mocks).
- V2 suite (`DustSweepPermit2RouterV2Test`) still passes — V2 untouched.
- Pre-existing `DustSweepRouter.t.sol` / `FeeCollector.t.sol` failures are **fork tests** that
  require `--fork-url https://mainnet.base.org` and are unrelated to this change (they fail the
  same way with these new files removed).

---

## 8. Security-audit response (2026-06-09)

Independent passes (Slither + Mythril + manual, and a separate self-review) found **0 critical /
0 high**. Disposition of every finding:

**Fixed in code**
- **Refund robustness (low):** `_refundLeftoverInputs` no longer `abi.decode`s a short (1–31 byte)
  token return — that decode would itself revert and brick the whole best-effort sweep. Now any
  non-compliant return → `RefundFailed` (left for `rescueERC20`), never a batch revert.
- **L-3 — `receive()` open to any sender:** `receive()` now reverts unless `msg.sender == weth`.
  (Force-sent ETH via `selfdestruct` is still possible and still recoverable via `rescueNative`;
  no logic depends on `address(this).balance`.)
- **I-2 — constructor shadowing:** renamed `_owner`/`_permit2`/… → `owner_`/`permit2_`/… to stop
  shadowing `Ownable._owner` (silences Slither `shadowing-local`).

**Accepted by design / governance (no code change)**
- **M-1 — owner allowlist + arbitrary call:** inherent to the "allowlisted target + user calldata"
  pattern; blast radius is bounded (per-route exact approvals reset to 0, delta accounting,
  `minAmountOut`, atomic txs → no cross-user theft). Mitigation = run `owner` as a
  **multisig + timelock**, vet every target/spender before allowlisting, monitor allowlist events.
  Per-target selector pinning was rejected: Universal/Smart routers expose many valid swap
  entrypoints, so it would break routing and force redeploys on every DEX update.
- **M-2 — per-leg slippage:** each leg's min-out is encoded **inside `route.data`** (the DEX
  enforces it) and the aggregate `minAmountOut` is the on-chain backstop. The frontend MUST set a
  tight per-leg min and a tight aggregate `minAmountOut` from fresh quotes.

**Off-chain / documentation**
- **L-1 — allowance-mode fee front-run:** Permit2 mode binds `feeBps` in the witness (user
  protected). In Allowance mode the app should pass an **explicit `feeBpsOverride`** (not the
  sentinel) so an owner `setFeeBps` can't change an in-flight sweep's fee. Worst case is bounded
  to `MAX_FEE_BPS` (3%) and requires the owner to act against users. (See the note in
  `apps/web/src/lib/dustsweep-router-v3.ts`.)
- **L-2 — fee-on-transfer / rebasing OUTPUT token:** `minAmountOut` is checked on the gross delta;
  a fee-on-transfer output would deliver slightly less than `netAmountOut`. Use a standard,
  non-FoT, non-rebasing `outputToken` (USDC/WETH/etc.) — same assumption as V2.
- **I-1 — native-output fee paid in WETH:** intended; the recipient gets unwrapped ETH, the fee
  goes to the collector as WETH (collector can unwrap).
- **I-3 — `tokenIn == outputToken` disallowed:** intended; sweeping WETH dust to native ETH is a
  direct unwrap, not a DEX swap, so it is out of scope for a route.

**Recommended before real value:** Foundry invariant/fuzz + Base-fork tests, `owner` on a
multisig+timelock, and a second independent review / bug bounty.

---

## 9. Live DEX coverage (quote engine)

The backend quote engine + `buildV2Route` now emit routes for:

| DEX | Status | Verification |
|---|---|---|
| Uniswap V3 (SwapRouter02) | live | existing |
| PancakeSwap V3 (SmartRouter) | live | existing |
| Aerodrome (classic / Solidly) | live | existing |
| BaseSwap | live | existing |
| **Aerodrome Slipstream (CL)** | **live (added 2026-06-09)** | Quoter `0x254cF9E1…E15b0` + SwapRouter `0xBE6D8f0d…6D18a5`, BaseScan labels + a live WETH→USDC quote (tickSpacing 100 → 16.73 USDC / 0.01 WETH). Router allowlisted ✓. |
| **Uniswap V4 (Universal Router)** | **live (fixed + fork-verified 2026-06-09)** | UR `0x6fF5693b…99b43` (Permit2 spender). Two fixes vs. the dormant code: (1) V4 Quoter ABI corrected to the deployed interface (`returns uint256 amountOut`; the old `int128[] deltaAmounts` ABI reverts); (2) removed `minHopPriceX36` from `ExactInputSingleParams` — the deployed UR rejects it. Fork test on Base (cancun) swaps 0.01 WETH → **16.02 USDC** end-to-end through `sweep()`. UR + Permit2 allowlisted ✓. See `test/DustSwapSweepRouterV4Fork.t.sol`. |

> V4 fork test is opt-in (network + cancun):
> `DUST_SWEEP_FORK_TESTS=1 forge test --match-contract DustSwapSweepRouterV4ForkTest --evm-version cancun -vv`.
> The default `forge test` skips it (no network). The live Universal Router uses transient storage,
> so it only executes under `--evm-version cancun` (Base's EVM); under the repo's `paris` profile it
> reverts `NotActivated` — that's an EVM-version artifact, not a code bug.

Still pending (whitelisted on-chain + in `dustsweepV3Sources.ts`, not yet emitted by the quoter):
- **DackieSwap V3, AlienBase V3** — clean `getV3QuoteCandidates` clones; need their QuoterV2 addresses verified before wiring (the verify-first rule; web search was unavailable).
- **Aerodrome Universal Router** — lower priority now that Aerodrome Slipstream (CL) + Aerodrome classic are both live, which already cover Aerodrome's liquidity.

Because the V3 contract runs **best-effort**, a miscoded new-DEX route fails safely (RouteSkipped + refund) rather than stranding funds — but each new DEX should still be smoke-tested with a small live sweep.
