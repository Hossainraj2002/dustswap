# Actual deployed Optimism router smoke check

**6 passed, 0 failed, 0 skipped**, using OP Mainnet fork block **158200380** on **2026-10-14**.

The tests called the actual deployed router **`0x54C177426033d50686bA7D36B690d1a2d7E34625`**.
They did not deploy a replacement, overwrite bytecode, impersonate the owner, or change owner
configuration/allowlists. Before each case, live fork getters had to match:

- Owner: `0xF113b1dBd848F44684f8543CcDf63C90f9535F57`
- Collector: `0xE09495e955794708D4bC28045C46891cAf643733`
- Default fee: **200 bps**; each tested sweep explicitly used the same 200 bps override
- Canonical Permit2 and OP WETH; unpaused; all five configured targets and self spenders allowed

Existing router reserves and collector/recipient balances were snapshotted, so assertions compare
real balance changes instead of assuming the deployed contract or collector started empty.

| Case | Result |
|---|---|
| Four-token allowance sweep into native ETH | Pass: real DAI via UniV3, USDC via UniV2, OP via Velodrome V2, plus WETH passthrough, one settlement |
| Same real batch through canonical Permit2 | Pass: real witness signature bound to deployed router; changed fee rejected; nonce consumed once; replay rejected |
| Impossible aggregate output floor | Pass: entire sweep rolls back, including inputs/allowances/payouts |
| One impossible UniV3 DAI leg | Pass: DAI refunded, three healthy legs settle, fee charged on reduced realized output |
| Fresh Kyber payload for deployed router | Pass: actual recipient/collector balances, exact approval cleanup, refund accounting |
| Fresh LI.FI payload for deployed router | Pass: actual recipient/collector balances, exact approval cleanup, refund accounting |

The test user's only synthetic funding was native ETH deposited into canonical WETH. DAI, USDC
and OP inputs were purchased from real forked DEX liquidity. No ERC-20 balances or swap targets
were mocked. Local Permit2 signatures use a test account derived from a public deterministic
label; no private environment key was read.

## Recorded settlement

Four-token native output:

| Amount | Actual |
|---|---:|
| Gross ETH denomination | 0.039824825119700315 |
| Collector fee, paid as WETH | 0.000796496502394006 |
| Recipient native ETH | 0.039028328617306309 |

One individually failing DAI route, with a global floor satisfied by the healthy routes:

| Amount | Actual |
|---|---:|
| Realized gross ETH denomination | 0.029884731966068528 |
| Collector fee, paid as WETH | 0.000597694639321370 |
| Recipient native ETH | 0.029287037326747158 |
| DAI returned to the user | 24.343465946231685185 |

This partial case asserted exactly three `RouteExecuted` events, one DAI `RouteSkipped`, one
aggregate `DustSwept`, and an `InputRefunded` amount matching the user's returned DAI. User and
DEX approvals ended at zero; pre-existing router reserves were preserved. If healthy output does
not satisfy the requested global floor, the whole sweep correctly reverts instead.

The separate 0.01 WETH aggregator cases realized:

| Provider | Gross USDC | Fee USDC | Net USDC | WETH refund |
|---|---:|---:|---:|---:|
| Kyber | 24.337060 | 0.486741 | 23.850319 | 0 |
| LI.FI | 24.261156 | 0.485223 | 23.775933 | 0 |

Fees use integer rounding down, as implemented by the router. Both cases asserted one executed
route and one settlement, exact recipient and collector deltas, zero final wallet/DEX allowance,
and no new router input/output remainder. Refund-event accounting also supports future payloads
that return unused WETH.

## Repeat without mainnet transactions

Test source: `packages/contracts/test/DustSwapSweepRouterOptimismDeployedFork.t.sol`.
The existing helper now accepts `-RouterAddress` to build payloads for the deployed address and
select the actual-router aggregator tests without configuring that router:

```powershell
cd C:\dustswap\packages\contracts
./script/VerifyOptimismAggregators.ps1 -RouterAddress 0x54C177426033d50686bA7D36B690d1a2d7E34625
$opDeployedFixture = Get-Content -LiteralPath 'out/optimism-deployed-aggregator-fixture.json' -Raw | ConvertFrom-Json
$env:DUST_SWEEP_OPTIMISM_DEPLOYED_FORK_TESTS = '1'
$env:DUST_SWEEP_OPTIMISM_DEPLOYED_AGGREGATOR_FORK_TESTS = '1'
$env:OPTIMISM_FORK_BLOCK = [string]$opDeployedFixture.forkBlock
forge test --match-contract DustSwapSweepRouterOptimismDeployedForkTest --evm-version cancun -vv
```

Set `OPTIMISM_MAINNET_RPC_URL` for a dedicated read provider if desired. API requests and fork
reads are public read-only operations. Opted-in RPC/payload/swap failures fail the check; without
the opt-in flags the tests explicitly skip. The initial run exposed a test-log buffering error
after successful aggregator balance checks; that harness error was corrected, and the complete
six-case rerun passed.

This proves the tested deployed-contract mechanisms at the recorded block. It does not prove
every asset or future provider route, wallet UI/atomic batching, application discovery, or gas
affordability. No mainnet transaction was signed or broadcast, and no runtime contract source
was changed by this check.
