# DustSwapSweepRouter V3 — Arbitrum One Deployment Runbook

Clone of the Robinhood runbook (`DustSwapSweepRouter-Robinhood-Deploy.md`), adapted for Arbitrum One
(chainId **42161**). Source: `DustSwapSweepRouter_Arbitrum_Remix.sol` — identical logic and external
ABI to the Ethereum/Robinhood builds; only the contract name is `DustSwapSweepRouterArbitrum`.
Arbitrum's native gas token IS ETH and its wrapped native is literally WETH, so the contract keeps
`weth`/`IWETH9` naming (no BSC-style WBNB rename).

> **No decoy problem here.** Unlike Robinhood — where the canonical mainnet Uniswap addresses were
> fake stubs — the canonical addresses on Arbitrum are **genuine**: SwapRouter02 `0x68b34658…`,
> QuoterV2 `0x61fFE014…` and factory `0x1F98431c…` all share deployer `0x6C9FC64A…` and carry
> verified contract names. Every Permit2 / Multicall3 / aggregator dependency is likewise at its
> canonical cross-chain address. Verified live 2026-08-07. **Re-verify each one with `eth_getCode`
> plus a functional probe immediately before sending the allowlist txs anyway.**

## 1. Compile (Remix)
- Source: `packages/contracts/remix/DustSwapSweepRouter_Arbitrum_Remix.sol`.
- Compiler: `0.8.24+commit.e11b9ed9`, **EVM version: `cancun`**, optimizer ON, runs `200`, license MIT.
- ArbOS **106** is live (read from the ArbSys precompile `0x…0064`, `arbOSVersion()` → `0x6a`), far
  past the ArbOS 40 Pectra floor, so `cancun` and EIP-7702 type-4 transactions are fully supported.

## 2. Deploy — constructor args
| Arg | Value | Notes |
|---|---|---|
| `permit2_` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical Permit2 — verified deployed on 42161 (verified name `Permit2`, canonical CREATE2 deployer) |
| `weth_` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | Arbitrum WETH — verified `symbol()=WETH`, `decimals()=18` |
| `owner_` | *same operator/multisig as Base* | |
| `feeCollector_` | *fee collector on 42161* | Treasury EOA works day one |
| `feeBps_` | `200` | Parity with your live prod fee on Base/Ethereum/BSC (`DUST_SWEEP_FEE_BPS*=200`). Contract cap `MAX_FEE_BPS = 300` |

> **Fee semantics — corrected 2026-08-08 after reading the deployed contract.** An earlier draft of
> this runbook (inherited from the Robinhood template) said the on-chain `feeBps` must equal
> `DUST_SWEEP_FEE_BPS_42161` or "a mismatch reverts every sweep". **That is not true.**
> `_resolveFeeBps` is:
> `effectiveFeeBps = override == FEE_OVERRIDE_SENTINEL ? feeBps : override;` then it reverts only
> if `effectiveFeeBps > MAX_FEE_BPS (300)`. The app **always** sends an explicit `feeBpsOverride`
> (never the sentinel) and clamps it to 300 client-side, so `FeeTooHigh` cannot fire.
> **Therefore `DUST_SWEEP_FEE_BPS_42161` is the fee actually charged**, and the stored on-chain
> `feeBps` is only a fallback the app never triggers. A mismatch does not revert — it silently
> charges the env value. Keep them equal anyway so the on-chain value documents the real fee.

Fund the deployer EOA with a little ETH on 42161 (deploy + all allowlist txs cost well under $1).

## 3. Verify on Arbiscan
`https://arbiscan.io` → Verify & Publish, single-file (`DustSwapSweepRouter_Arbitrum_Remix.sol`),
identical compiler settings (0.8.24, cancun, optimizer 200).

## 4. Owner allowlist (setAllowedTarget / setAllowedSpender)
**Re-verify every address with live `eth_getCode` AND a functional probe before sending.** All
Arbitrum targets are self-model (the DEX/aggregator itself pulls the ERC-20), so each address gets
BOTH `setAllowedTarget(addr, true)` and `setAllowedSpender(addr, true)` — **14 owner txs total**. No
extra Permit2 spender entry is needed: the router's own Permit2 pull path uses the immutable
constructor `permit2_`, not the spender allowlist.

### LIVE at launch
| DEX / Aggregator | Address | Verified how (2026-08-07) |
|---|---|---|
| Uniswap V3 SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | verified name `SwapRouter02`; deployer `0x6C9FC64A…` shared with QuoterV2 `0x61fFE014…` (`QuoterV2`) and factory `0x1F98431c…` (`UniswapV3Factory`) |
| SushiSwap V2 Router | `0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506` | verified name `UniswapV2Router02`; `factory()` → `0xc35DADB65012eC5796536bD9864eD8773aBc74C4` |
| Kyber MetaAggregationRouterV2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | `/arbitrum/api/v1/routes` returned `routerAddress` == this, with a real 0.1 WETH → 191.408468 USDC route; verified name `MetaAggregationRouterV2` |
| LI.FI Diamond | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | `/v1/quote` fromChain=42161 returned it as **both** `approvalAddress` and `transactionRequest.to`; verified `LiFiDiamond` (EIP-2535, `GenericSwapFacetV3` present) |
| **OpenOcean Exchange Proxy** | `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` | ⚠️ **LIVE on Arbitrum** — see §4.1. Verified `OpenOceanExchangeProxy` (EIP-1967 → `OpenOceanExchange`); `v4/arbitrum/dexList` returned 66 indexed DEXes |
| 0x AllowanceHolder | `0x0000000000001fF3684f28c67538d4D072C22734` | verified name `AllowanceHolder` at the canonical address. API support for chainId=42161 unproven from outside — allowlist now, keep `DUST_SWEEP_ENABLE_ZEROX_42161` **OFF** until a keyed quote passes |

### PARKED (pre-allowlist on-chain, app-side OFF)
| Venue | Address | Notes |
|---|---|---|
| Camelot V3 SwapRouter | `0x1F721E2E82F6676FCE4eA07A5958cF098D339e18` | ⚠️ **Not a flag flip.** Camelot is **Algebra V1.9**, a different interface generation from the Algebra *Integral* wiring this repo has for QuickSwap/Hydrex on Base: `exactInputSingle` has **no `deployer` field** (selector `0xbc651188` vs `0x1679c792`) and its Quoter takes flat args (`0x2d9ebd1d` vs `0xe94764c4`). Enabling it needs a **new calldata builder + DEX enum**. Allowlisted now so that future work needs no owner tx. Camelot liquidity is already reachable via OpenOcean / Kyber / LI.FI. |

**No Odos entry** — Odos was removed as a routing provider on every chain (2026-07-27).

### 4.1 OpenOcean is LIVE here — mandatory pre-announce check
This is a deliberate, **Arbitrum-only** deviation: OpenOcean ships parked on Base/Ethereum/BSC/
Robinhood. It is enabled here because its live Arbitrum dexList indexes 66 venues — `CamelotV3`,
`Camelot`, `GMXV2`, `FluidDex`, `Pendle`, `RamsesCL`, `TraderJoeV2.2`, `MaverickV2`, `SolidlyV3`,
`UniswapV4`, `Curve`/`CurveV2`, `WOOFiV2.1`, `Bebop`, `HashflowV3` — far wider long-tail coverage
than Uniswap V3 + Sushi + Kyber + LI.FI combined, and it is what covers Camelot while the native
Algebra V1.9 adapter is deferred.

**Before announcing the chain**, execute one real OpenOcean swap payload end-to-end on 42161
(quote → allowlist check → build → sign → settle) and confirm the returned `to`/`spender` both equal
`0x6352a56caadC4F1E25CD6c75970Fa768A3304e64`. This is exactly the swap-payload verification the
parked status defers elsewhere; we do it up front instead of skipping it.

**Kill switch:** `DUST_SWEEP_ENABLE_OPENOCEAN_42161=false` — one env var, no redeploy, chain stays up.

## 5. Envs — see `docs/dustsweep-arbitrum-42161-plan.md` §3
Critical ones:
- `DUST_SWEEP_ROUTER_V3_ADDRESS_42161` = deployed address (Railway) **and**
  `NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_42161` = same (Cloudflare)
- `DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_42161` — aggregators return **nothing** unless both this
  and the router address are set
- `DUST_SWEEP_FEE_BPS_42161` = `200` — this value **is** the fee charged (see §2)
- `ALCHEMY_ARBITRUM_RPC_KEYS` — **server-side only**, never `NEXT_PUBLIC_*`
- `COINGECKO_API_KEY` — **blocker for the flag flip**; price coverage is token visibility, and this
  also re-arms `reconcileThinPoolPrices`
- **Leave unset:** `DUST_SWEEP_DISCOVERY_MAX_ERC20_BALANCES`,
  `DUST_SWEEP_DISCOVERY_TARGET_NONZERO_BALANCES`, `DUST_SWEEP_ALCHEMY_MAX_PAGES`,
  `DUST_SWEEP_BLOCKSCOUT_BALANCE_MAX_PAGES` — each defaults to `null` = unlimited; setting one
  silently truncates a large dust wallet

## 6. Go live
Append `42161` to `DUST_SWEEP_ENABLED_CHAIN_IDS` and `NEXT_PUBLIC_DUST_SWEEP_ENABLED_CHAINS` — last.

## 7. Rollback
Remove `42161` from both lists. Every code path is additive and chain-gated; Base/Ethereum/BSC/
Robinhood are unaffected at all times.
