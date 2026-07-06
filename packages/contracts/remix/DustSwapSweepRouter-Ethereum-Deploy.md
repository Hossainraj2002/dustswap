# DustSwapSweepRouter V3 — Ethereum Mainnet Deployment Runbook

Clone of the Base V3 runbook (`DustSwapSweepRouter-V3-Deploy.md`), adapted for Ethereum mainnet
(chainId 1). Same source (`DustSwapSweepRouter_Remix.sol`) — only the constructor args, verification
endpoint, and the DEX/aggregator allowlist differ.

> **Do NOT change `foundry.toml`'s `evm_version = "paris"` in this work.** Remix compiler settings
> govern the deployed bytecode; the `ethereum_mainnet` rpc/etherscan entries added to foundry.toml
> are only for `forge verify`/scripts.

## 1. Compile (Remix)
- Source: `packages/contracts/remix/DustSwapSweepRouter_Remix.sol` (identical to Base).
- Compiler: `0.8.24+commit.e11b9ed9`, **EVM version: `cancun`** (mainnet supports it), optimizer ON,
  runs `200`, license MIT.

## 2. Deploy — constructor args
| Arg | Value | Notes |
|---|---|---|
| `_permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical Permit2 — SAME address as Base |
| `_weth` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | Mainnet WETH (differs from Base) |
| `_owner` | *same operator/multisig as Base* | |
| `_feeCollector` | *mainnet fee collector* | Deploy a mainnet FeeCollector first, or use treasury EOA |
| `_feeBps` | `60` | Parity with Base prod (contract cap = 300) |

Fund the deployer EOA with real ETH for deploy + the owner allowlist txs below.

## 3. Verify on Etherscan
Verify & Publish, single-file, identical compiler settings (0.8.24, cancun, optimizer 200).

## 4. Owner allowlist (setAllowedTarget / setAllowedSpender)
**Re-verify every address with live `eth_getCode` AND a live aggregator quote before sending** —
never trust explorer labels alone (prior Base lesson).

### LIVE at launch (native + Kyber/0x/LI.FI)
`setAllowedTarget(addr, true)` **and** `setAllowedSpender(addr, true)` for each:
| DEX / Aggregator | Address | Spender model |
|---|---|---|
| Uniswap V3 SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | self |
| Uniswap Universal Router (V3+V4) | `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af` | spender = Permit2 |
| Uniswap V2 Router02 | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` | self |
| SushiSwap Router | `0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F` | self |
| Kyber MetaAggregationRouterV2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | self |
| 0x AllowanceHolder | `0x0000000000001fF3684f28c67538d4D072C22734` | self |
| LI.FI Diamond | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | self |
| Permit2 (spender only) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | — |

### PARKED (pre-allowlist on-chain, keep app-side OFF)
Allowlist these so they can be flipped on later without a new owner tx; they stay inert until
`DUST_SWEEP_ENABLE_OPENOCEAN_1` / `DUST_SWEEP_ENABLE_ODOS_1` = true AND their addresses are added to
`DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_1`:
| Aggregator | Address |
|---|---|
| OpenOcean Exchange Proxy | `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` |
| Odos RouterV2 | `0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559` |

## 5. Post-deploy sanity
- `feeBps() == 60`, `feeCollector()`, `owner()` correct.
- `allowedTargets(x) == true` / `allowedSpenders(x) == true` spot-checks for the LIVE set.
- One owner-signed dust sweep (Phase 5 canary wallet) before enabling for users.

## 6. Wire the app (do NOT enable for users yet)
API env (host platform):
```
DUST_SWEEP_ROUTER_V3_ADDRESS_1=<deployed address>
DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_1=0x6131B5fae19EA4f9D964eAc0408E4408b66337b5,0x0000000000001fF3684f28c67538d4D072C22734,0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
DUST_SWEEP_ENABLED_CHAIN_IDS=8453,1   # flip LAST, after curl-testing the endpoints
```
Web env (GitHub secrets + deploy-web.yml):
```
NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_1=<deployed address>
NEXT_PUBLIC_DUST_SWEEP_ENABLED_CHAINS=8453,1   # flip LAST
```
