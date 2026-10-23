# DustSwapSweepRouter V3 — OP Mainnet deployment

Status: deployed and source-verified on **2026-10-14**, with all five target/spender pairs configured.
Router: [`0x54c177426033d50686ba7d36b690d1a2d7e34625`](https://optimistic.etherscan.io/address/0x54c177426033d50686ba7d36b690d1a2d7e34625#code).
Optimistic Etherscan reports **Source Code Verified — Exact Match**, Solidity 0.8.24, optimizer 200,
Cancun and MIT. Chain 10 remains disabled in the application pending database and app release checks.
See `docs/dustsweep-optimism-10-plan.md` for the system walkthrough and rollout plan.

## Completed deployment

- Owner/deployer: `0xF113b1dBd848F44684f8543CcDf63C90f9535F57` (the explicitly requested MemeFun wallet).
- Fee recipient: `0xE09495e955794708D4bC28045C46891cAf643733`.
- Default fee and local API override: **200 bps (2%)**.
- Deployment transaction: [`0x4f6cdb935ab09b0b3f24eca70128db641294016a3bd18b97a462d53e307b227e`](https://optimistic.etherscan.io/tx/0x4f6cdb935ab09b0b3f24eca70128db641294016a3bd18b97a462d53e307b227e), block **158199756**.
- Ten successful owner transactions enabled the five lanes below; final configuration block **158199832**.
- Full runtime bytecode, including metadata and constructor immutables, matches the audited artifact:
  `0xfff877b535f1a3a9bce14ef6c76c333e1a70dc860fb09fb33dbc37686f66fe9a`.
- Post-deployment reads confirmed owner, collector, 200 bps, canonical Permit2/WETH, unpaused state,
  and all ten target/spender flags. Fresh pre-deployment checks passed 36 unit tests and nine core
  OP fork tests at block **158199606**.
- Deployment plus allowlist transactions used **0.000003887732739673 ETH**; the owner had
  **0.000598738177721060 ETH** remaining at the recorded post-deployment balance read.
- Local API/web `.env.local` files now contain this OP router address. Both enabled-chain lists remain
  `8453,1,56`; production SQL, application release and a connected-wallet sweep are still pending.

Public transaction journal, exact Standard JSON and constructor arguments are saved under
`packages/contracts/deployments/optimism/2026-10-14*`. Source verification used the requested
Optimistic Etherscan web form; no wallet key or explorer credential was uploaded.

The post-deployment recheck passed six fork cases against this **actual deployed address** at
block **158200380**, without deploying a replacement or impersonating/configuring the owner.
These cover real four-token native settlement, canonical Permit2 witness/replay handling,
aggregate rollback, partial-leg refunds and fresh Kyber/LI.FI execution. Fees, approvals and
pre-existing reserves are checked. Repeat the actual-address aggregator cases with:

```powershell
./script/VerifyOptimismAggregators.ps1 -RouterAddress 0x54C177426033d50686bA7D36B690d1a2d7E34625
```

Use `DustSwapSweepRouterOptimismDeployedForkTest` and the two `DUST_SWEEP_OPTIMISM_DEPLOYED_*`
opt-in flags to run all six cases, as documented in
`output/optimism-coverage/deployed-router-smoke-2026-10-14.md`. These tests broadcast nothing.
The production API still returns `CHAIN_NOT_ENABLED` for chain 10; on-chain readiness does not
activate the application automatically.

## Chain and deployment source

OP Mainnet uses chain ID **10**, native **ETH**, and public read RPC
`https://mainnet.optimism.io`. The sequencer URL is write-only and must not be used as the app's read
RPC. The public endpoint is rate limited; configure a production RPC provider for normal traffic.
Source: [Optimism network information](https://docs.optimism.io/op-mainnet/network-information/connecting-to-op).

Deploy `packages/contracts/remix/DustSwapSweepRouter_Optimism_Remix.sol`, contract
**`DustSwapSweepRouterOptimism`**. This file was generated with `forge flatten` from the canonical
`src/DustSwapSweepRouter.sol`; only the contract name and chain documentation were changed. The
wallet-facing sweep ABI, Permit2 witness hashes, exact approvals, fee cap and native-output flow
remain compatible with the existing deployments. The follow-up audit corrected shared reserve and
refund accounting in the canonical source and regenerated this OP artifact. Swaps, refunds and
settlement cannot consume balances held before the sweep; malformed token responses are isolated.
Two additive self-only helpers preserve existing selectors without persistent reserve storage.
The corrected source passes 36 unit tests. Already-deployed routers do not acquire these fixes
automatically.

Remix settings: **Solidity 0.8.24+commit.e11b9ed9**, optimizer **enabled**, runs **200**, EVM **cancun**,
**viaIR disabled**, license MIT. Record these settings and the exact source used for explorer
verification. OP Mainnet supports Cancun; its active Isthmus upgrade also includes EIP-7702.
Chain support does not establish any individual wallet's batching capability: the app must retain
its existing live EIP-5792 capability checks.
Source: [Isthmus registry and EIP list](https://docs.optimism.io/op-stack/protocol/hardforks/isthmus).

## Constructor

| Argument | Value |
|---|---|
| `permit2_` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| `weth_` | `0x4200000000000000000000000000000000000006` |
| `owner_` | Intended operator or multisig on chain 10 |
| `feeCollector_` | Intended fee treasury on chain 10 |
| `feeBps_` | `200` (2%; immutable maximum remains 300 bps) |

The backend sends an explicit fee override. `DUST_SWEEP_FEE_BPS_10` determines that override; the
stored `feeBps` is only the fallback for the sentinel value. Keep both at 200 for consistent
configuration. Native ETH sweeps pay the collector in **WETH** and unwrap only the recipient's net
amount. Input ETH is unsupported; only ERC-20 inputs, including WETH, are accepted.

## Active owner allowlist

The following five targets use the **self** spender model: add each address with
`setAllowedTarget(address, true)` and `setAllowedSpender(address, true)` (**10 owner transactions**).
No Permit2 spender allowlist entry is needed for these lanes; the user's signature input pull uses
the constructor's immutable Permit2 independently of the DEX spender allowlist.

| Lane | Target and spender | Source |
|---|---|---|
| Uniswap V3 SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | [Official OP V3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-optimism-deployments) |
| Uniswap V2 Router02 | `0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2` | [Official V2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments) |
| Velodrome V2 Router | `0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858` | [Velodrome deployment table](https://github.com/velodrome-finance/contracts/blob/main/README.md#deployment) |
| Kyber MetaAggregationRouterV2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | [Official Optimism quote endpoint](https://aggregator-api.kyberswap.com/optimism/api/v1/routes) returned this `routerAddress` |
| LI.FI Diamond | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | [Official LI.FI quote endpoint](https://li.quest/v1/quote) returned this as both approval address and transaction target for chain 10 |

Re-run bytecode, immutable/getter, and functional quote checks immediately before configuring the
allowlist. An address being deployed is insufficient evidence that a quote uses the expected
spender. The app separately validates aggregator returned targets and spenders against its
chain-specific policy. The owner allowlist and the backend policy must both permit the route.

Direct adapters for Uniswap V4 and Velodrome Slipstream are outside the active launch lanes.
Kyber and LI.FI may reach those venues internally through their validated aggregator payloads.
OpenOcean and 0x remain disabled pending their own build/simulation verification. Do not copy a
Universal Router allowance model onto the V2 or V3 direct routers: these direct routers spend their
own exact ERC-20 allowance.

## Read-only verification

The helper sends only chain/code/getter RPC reads and requires `cast` on PATH:

```powershell
cd C:\dustswap\packages\contracts
./script/VerifyOptimismDependencies.ps1
# After deployment and allowlisting:
./script/VerifyOptimismDependencies.ps1 -RouterAddress 0xYourDeployedRouter
```

Use `-RpcUrl` or `OPTIMISM_MAINNET_RPC_URL` for a dedicated provider. When supplied a router address,
the helper verifies the immutables, default fee, unpaused state, and all five active target/spender
allowlist entries; it prints the owner and collector for comparison with the intended accounts.
It does not deploy, sign, fund, or broadcast.

The meaningful execution check imports the **exact Remix source** and forks OP Mainnet locally:

```powershell
$env:DUST_SWEEP_OPTIMISM_FORK_TESTS = '1'
$env:OPTIMISM_MAINNET_RPC_URL = 'https://mainnet.optimism.io'
# Optional reproducible block, verified against the final artifact 2026-10-13:
$env:OPTIMISM_FORK_BLOCK = '158154661'
forge test --match-contract DustSwapSweepRouterOptimismForkTest --evm-version cancun -vv
```

The core suite covers Uniswap V3, Uniswap V2 and Velodrome V2 WETH → Circle USDC execution,
WETH → native ETH passthrough, and the following mixed-token cases:

- One `sweep` call exchanges real **DAI via Uniswap V3**, **Circle USDC via Uniswap V2** and
  **OP via Velodrome V2**, combines them with a WETH passthrough leg, charges one 2% aggregate
  fee and pays the net amount as native ETH. Test inputs are bought from the actual forked DEX
  pools; no tokens or swap targets are mocked.
- The same four-token batch works through the deployed canonical **Permit2** with a real EIP-712
  witness signature. Changing the fee, recipient or route calldata invalidates the signature;
  replaying a successful signature fails. A valid signed batch that fails the aggregate output
  floor restores the nonce and all inputs/approvals, and a new signature can reuse that nonce.
- An impossible aggregate minimum rolls every leg back. An individually failing real DEX leg is
  refunded while the other legs settle, preserving the existing best-effort behavior.

All nine core cases, both single-token aggregator cases and the additional five-token basket
passed against the final artifact at block **158154661** on **2026-10-13** (12 passed, no failures
or skips).

Checks include quoted gross output, the 2% fee, settlement, zero stranded input/output and zero
final DEX/user allowance. The
Velodrome route uses the real V2 tuple `(from,to,stable,factory)`, including factory
`0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a`. The V3 router uses the SwapRouter02 tuple **without a
deadline member**; the overall sweep deadline remains enforced by the sweep router.
The tests report explicit skips unless opted in, and fail on an RPC/quote/swap error when opted in.
Omit `OPTIMISM_FORK_BLOCK` for a fresh-state verification before launch.

Build fresh public aggregator API payloads for the deterministic local test router and simulate
them through the exact Remix contract with:

```powershell
./script/VerifyOptimismAggregators.ps1
```

This read-only helper checks canonical target/spender, same-chain routing, zero native call value
and positive quoted output, writes a temporary fixture under ignored `out/`, and runs the two
aggregator fork tests. It broadcasts nothing and restores process-local test variables afterward.
Tests enforce a positive output floor, realized-output fees, zero final aggregator approval and
exact refund-event accounting for unused input. At block **158154661**, Kyber produced
**25,184,979** raw USDC and LI.FI produced **25,096,976** raw USDC, both with no input remainder.
Earlier LI.FI payloads returned unused WETH; tests account for the realized refund rather than
requiring every provider to consume its full input. API estimates are not treated as exact execution
amounts. An opted-in API/payload/fork failure fails the check and remains a provider release gate.

The additional read-only basket helper purchases wstETH, rETH, SNX, current VELO V2 and WBTC from
real forked DEX liquidity, then executes five fresh Kyber payloads in one router sweep:

```powershell
./script/VerifyOptimismAggregatorBasket.ps1
```

At block 158154661, all five legs executed with one settlement: 11.316901 USDC gross,
0.226338 USDC fee and 11.090563 USDC net. Unselected purchase remainders/refunds are accounted for,
all exact approvals are consumed/reset and no basket input/output remains in the router. Executed
internal venues include Velodrome concentrated pools, Uniswap V4 and Sushi V3 behind the canonical
Kyber target. The helper signs/broadcasts nothing and requires an actual passing test result.
Its local EVM gas measurement can benefit from warm state after test purchases; it excludes
intrinsic gas, calldata/L1 data/operator fees and wallet batching, so it is not a production fee
estimate.

To repeat all twelve cases with fresh fixtures at one block:

```powershell
./script/VerifyOptimismAggregatorBasket.ps1
$opBasketFixture = Get-Content -LiteralPath 'out/optimism-aggregator-basket-fixture.json' -Raw | ConvertFrom-Json
./script/VerifyOptimismAggregators.ps1 -ForkBlock $opBasketFixture.forkBlock
$env:DUST_SWEEP_OPTIMISM_FORK_TESTS = '1'
$env:DUST_SWEEP_OPTIMISM_AGGREGATOR_FORK_TESTS = '1'
$env:DUST_SWEEP_OPTIMISM_AGGREGATOR_BASKET_FORK_TESTS = '1'
$env:OPTIMISM_FORK_BLOCK = [string]$opBasketFixture.forkBlock
forge test --match-contract DustSwapSweepRouterOptimismForkTest --evm-version cancun -vv
```

Set `OPTIMISM_MAINNET_RPC_URL` for a dedicated read provider. Market movement between API reads
and the fork can legitimately invalidate a payload; regenerate both fixtures if that occurs.

One router `sweep` call is one atomic on-chain execution. A wallet still needs the exact input
allowances: plain EOAs with no prior Permit2 allowances may need approval transactions first;
wallets with live EIP-5792 atomic capability may batch exact approvals and the sweep. Fork tests
prove the contract execution and signature paths, not every wallet's user-interface behavior.

On **2026-10-12**, read-only OP bytecode checks found **11 of the 13** known wallet-brand delegate
addresses deployed at block **158112592**. The primary Uniswap Calibur delegate is present, but
secondary Uniswap entries `0x0c338ca25585035142a9a0a1eeeba267256f281f` and
`0x458f5a9f47a01bea5d7a32662660559d9ed3312c` have no code on OP. Registry entries provide labels;
the app must use actual account delegation and live wallet capabilities to select batching.

Dependency bytecode/getters and live quote APIs were also checked. Circle's native USDC address is
`0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`, **6 decimals**; legacy bridged USDC.e at
`0x7F5c764cBc14f9669B88837ca1490cCa17c31607` is an ordinary sweep input, separate from the default
USDC output. Source: [Circle contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
The public Kyber and LI.FI built-payload fork checks above establish current execution compatibility.
Repeat payload simulation and wallet checks using the eventual deployed router address before
production activation. The helper above simulates its deterministic local test address; it does
not by itself validate an eventual production deployment at a different address.

## Application activation

After source verification and owner configuration:

1. Apply the checked-in Optimism seed SQL to the intended database using the normal release flow.
2. Set backend `DUST_SWEEP_ROUTER_V3_ADDRESS_10` and frontend
   `NEXT_PUBLIC_DUST_SWEEP_ROUTER_V3_ADDRESS_10` to the same deployed address.
3. Set backend `DUST_SWEEP_FEE_BPS_10=200`; set
   `DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_10` to the Kyber and LI.FI addresses above. Confirm their
   corresponding provider flags and API credentials. Keep 0x/OpenOcean disabled.
4. Configure server-side `ALCHEMY_OPTIMISM_RPC_KEYS` and any provider price/discovery credentials.
   Keep provider keys out of public frontend variables.
5. With chain 10 available in a staging environment, check discovery/pricing and build/simulate a
   multi-token USDC sweep and a native ETH sweep. Exercise Permit2 signature mode and a capable
   wallet's EIP-5792 batch. Check wallet fee estimates, exact approvals and balance settlement.
6. Append `10` to `DUST_SWEEP_ENABLED_CHAIN_IDS` and
   `NEXT_PUBLIC_DUST_SWEEP_ENABLED_CHAINS` last; preserve every already-enabled chain ID.

The initial application cap is 10 routes per batch and $0.01 per input. OP transaction costs include
execution gas, L1 data and an operator fee: the wallet's full transaction estimate is authoritative
for affordability. Source: [Optimism fees](https://docs.optimism.io/op-stack/transactions/fees).

Rollback by removing `10` from both enabled-chain lists and redeploying the application config.
If immediate on-chain suspension is required, the owner may pause the Optimism sweep router. Other
chain deployments and their configuration remain independent.
