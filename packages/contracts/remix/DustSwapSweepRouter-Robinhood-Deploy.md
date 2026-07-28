# DustSwapSweepRouter V3 — Robinhood Chain Deployment Runbook

Clone of the Ethereum runbook (`DustSwapSweepRouter-Ethereum-Deploy.md`), adapted for Robinhood
Chain (chainId **4663**). Source: `DustSwapSweepRouter_Robinhood_Remix.sol` — identical logic and
external ABI to the Ethereum build; only the contract name is `DustSwapSweepRouterRobinhood`.
Robinhood's native gas token IS ETH and its wrapped native is literally WETH, so the contract
keeps `weth`/`IWETH9` naming (no BSC-style WBNB rename).

> **DECOY WARNING (why we verify):** the canonical mainnet Uniswap addresses are FAKE on this
> chain — `0x1F98431c…` is a Solidity-0.4.26 stub whose `getPool()` returns empty, and canonical
> SwapRouter02 `0x68b34658…` has NO code. Every address below was verified live 2026-07-26 via
> `eth_getCode` + a functional probe (quoter/getAmountsOut call or live aggregator API response)
> on `https://rpc.mainnet.chain.robinhood.com`. **Re-verify each one the same way immediately
> before sending the allowlist txs.**

## 1. Compile (Remix)
- Source: `packages/contracts/remix/DustSwapSweepRouter_Robinhood_Remix.sol`.
- Compiler: `0.8.24+commit.e11b9ed9`, **EVM version: `cancun`** (ArbOS 40+ supports it; chain is
  on ArbOS 61), optimizer ON, runs `200`, license MIT.

## 2. Deploy — constructor args
| Arg | Value | Notes |
|---|---|---|
| `permit2_` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical Permit2 — verified deployed on 4663 (9152 bytes) |
| `weth_` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Robinhood WETH — verified symbol()=WETH, decimals()=18 |
| `owner_` | *same operator/multisig as Base* | |
| `feeCollector_` | *fee collector on 4663* | Treasury EOA works day one |
| `feeBps_` | `60` | Parity with Base prod (contract cap = 300). **MUST equal `DUST_SWEEP_FEE_BPS_4663`** — the app sends an explicit `feeBpsOverride` and a mismatch reverts every sweep |

Fund the deployer EOA with a little ETH on 4663 (gas is ~0.1–0.4 gwei; deploy + all allowlist txs
cost well under $1).

## 3. Verify on Blockscout
`https://robinhoodchain.blockscout.com` → Verify & Publish, single-file
(`DustSwapSweepRouter_Robinhood_Remix.sol`), identical compiler settings (0.8.24, cancun,
optimizer 200).

## 4. Owner allowlist (setAllowedTarget / setAllowedSpender)
**Re-verify every address with live `eth_getCode` AND a functional probe before sending** — never
explorer labels (see decoy warning above). All Robinhood targets are self-model (the DEX router
itself pulls the ERC-20), so each address gets BOTH `setAllowedTarget(addr, true)` and
`setAllowedSpender(addr, true)` — **12 owner txs total**. No extra Permit2 spender entry is
needed (unlike Ethereum's Universal Router row): the router's own Permit2 pull path uses the
immutable constructor `permit2_`, not the spender allowlist.

### LIVE at launch (native Uniswap + Kyber/LI.FI; 0x pre-allowlisted but app-side OFF)
| DEX / Aggregator | Address | Verified how (2026-07-26) |
|---|---|---|
| Uniswap V3 SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` | factory()=0x1f7d7550…, WETH9()=WETH; official QuoterV2 `0x33e885eD…` quoted WETH→USDG fee 100 ≈ 188.26/0.1 WETH; pools $5.9M/$2.4M/$0.45M |
| Uniswap V2 Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` | same official deployer (0x9701fb0a…); getAmountsOut(0.1 WETH→USDG) ≈ 188.15 |
| Kyber MetaAggregationRouterV2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | /robinhood/api/v1/routes returned routerAddress == this; eth_getCode 13724 B |
| LI.FI Diamond (Robinhood) | `0xB477751B76CF82d00a686A1232f5fCD772414Af3` | **NOT the canonical Diamond** (0x1231DEB6… has no code on 4663). Blockscout-verified contract name `LiFiDiamond`; /v1/quote returns it as approvalAddress + transactionRequest.to |
| 0x AllowanceHolder | `0x0000000000001fF3684f28c67538d4D072C22734` | eth_getCode 1009 B. API support for chainId=4663 unproven — allowlist now, keep `DUST_SWEEP_ENABLE_ZEROX_4663` OFF until a keyed quote passes |

### PARKED (pre-allowlist on-chain, keep app-side OFF)
| Aggregator | Address | Notes |
|---|---|---|
| OpenOcean Exchange Proxy | `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` | v4/robinhood/quote answers live; enable later via `DUST_SWEEP_ENABLE_OPENOCEAN_4663` + swap-payload verification |

**No Odos entry** — Odos was removed as a routing provider on every chain (2026-07-27), and it
does not support chainId 4663 anyway (`/info/contract-info/v2/4663` → "Invalid chain ID"). Never
allowlist an Odos address here.

## 5. Post-deploy sanity
- `feeBps() == 60`, `feeCollector()`, `owner()`, `weth() == 0x0Bd7D308…`, `permit2() == 0x0000…BA3`.
- `allowedTargets(x) == true` / `allowedSpenders(x) == true` spot-checks for all 6 addresses.
- One owner-signed canary sweep (small WETH→USDG) before enabling for users. This canary also
  answers whether MetaMask/OKX enable EIP-5792 batching on this chainId — if not, the
  sequential/Permit2 lane handles it automatically (same fallback as any non-5792 wallet).

## 6. Alchemy + Blockscout pre-flight (before flipping the chain on)
- Alchemy dashboard → each app in `ALCHEMY_ROBINHOOD_RPC_KEYS` → Networks → enable **Robinhood**.
  Then confirm the token API answers:
  `curl -X POST https://robinhood-mainnet.g.alchemy.com/v2/<key> -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getTokenBalances","params":["0xc177A718027f8e9243937c897d6D7Dd2104dC444","erc20"]}'`
  (Discovery still has the Blockscout REST fallback via `robinhoodchain.blockscout.com`, wired in
  `sweepChains.ts` `blockscoutRestBaseUrl`, reusing the existing `BLOCKSCOUT_API_KEYS`.)
- Hosted Blockscout JSON-RPC (`chainRpc.ts` `blockscoutSupported`, currently `false` for 4663):
  test once with a LIVE Railway key —
  `curl -X POST https://api.blockscout.com/4663/json-rpc -H "Authorization: Bearer <key>" -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'`
  → if it returns `0x1237`, flip `blockscoutSupported: true` in a follow-up commit for the extra
  RPC failover lane. (It answered 402-keyed on 2026-07-26; local keys were stale, inconclusive.)

## 7. Wire the app (do NOT enable for users yet)
API env (Railway):
```
DUST_SWEEP_ROUTER_V3_ADDRESS_4663=<deployed address>
DUST_SWEEP_FEE_BPS_4663=60
ALCHEMY_ROBINHOOD_RPC_KEYS=<key1>,<key2>,...
# Optional (registry default already covers Kyber/0x/LI.FI/OpenOcean + native routers):
DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_4663=0x6131B5fae19EA4f9D964eAc0408E4408b66337b5,0xB477751B76CF82d00a686A1232f5fCD772414Af3,0x0000000000001fF3684f28c67538d4D072C22734
DUST_SWEEP_ENABLED_CHAIN_IDS=8453,1,56,4663   # flip LAST, after curl-testing the endpoints
```
Web env (GitHub secrets + deploy-web.yml):
```
NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_4663=<deployed address>
NEXT_PUBLIC_ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com   # optional; baked default exists
NEXT_PUBLIC_DUST_SWEEP_ENABLED_CHAINS=8453,1,56,4663   # flip LAST
```
