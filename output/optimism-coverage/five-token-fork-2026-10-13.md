# Five real Optimism inputs in one sweep

The exact Optimism Remix router passed the complete **12-test** live OP fork suite at block
**158154661**, with **0 failures and 0 skips**. The new basket case acquired wstETH, Rocket Pool
rETH, SNX, VELO V2 and WBTC using real forked liquidity, then exchanged the five selected inputs
through **one `sweep` call** and five fresh Kyber payloads into native Circle USDC.

The only test funding was native ETH for the buyer, deposited into canonical WETH. No ERC-20
balances or swap targets were mocked. Five acquisition swaps prepared the inputs; those are test
setup, separate from the single sweep being proved. Each acquisition spent up to 0.001 WETH.
The selected input was 90% of the API's buy estimate, safely below the default 95% buy output
floor. Any unselected purchased remainder stayed in the buyer's wallet and was included in the
balance assertions.

| Input | Selected smallest units | Acquisition route identifiers | Sweep route identifiers |
|---|---:|---|---|
| wstETH | 722332636172925 | solidly-v3 | velodrome-cl-3 |
| Rocket Pool rETH | 769941504973689 | solidly-v3, uniswap-v4 | uniswap-v4, velodrome-cl-3 |
| SNX | 9567616166884330904 | uniswapv3 | velodrome-cl-2 |
| VELO V2 | 58098427128261749144 | velodrome-cl-3 | velodrome-cl-2 |
| WBTC | 2721 | velodrome-cl-2 | sushiswap-v3 |

These are the provider's actual internal route identifiers. All calls used the canonical Kyber
target and spender `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`. The sweep payloads named the exact
locally deployed router as sender and recipient. This establishes execution through the aggregator
for these tested venues; it does not introduce a direct V4 or concentrated-liquidity adapter.

| Settlement | Actual result |
|---|---:|
| Gross Circle USDC | 11.316901 |
| One aggregate protocol fee, 2% | 0.226338 |
| One recipient payout | 11.090563 |
| Executed sweep legs | 5 |
| Skipped sweep legs | 0 |
| Aggregate `DustSwept` events | 1 |
| Router input/output balances afterward | 0 |
| Final router-to-Kyber and exact user-to-router allowances | 0 |

Per-token assertions account for every unselected input and any `InputRefunded` event. Every
route must consume a positive selected amount. The test requires all five route executions and
the sum of positive per-route output floors, so a partially successful batch cannot be mistaken
for this result.

The measured `gasleft()` delta around the router call was **1,580,417 EVM gas**. Purchases earlier
in the same Solidity test may warm token and pool slots. This is a local call benchmark, **not a
cold production transaction fee estimate**: intrinsic/calldata gas charges, wallet approval
bundles, OP L1 data fees and operator fees are outside this measurement. The full Foundry test's
10,687,642 gas additionally includes acquisitions, JSON fixture parsing and assertions.

The refreshed standalone aggregator cases also passed at the same block: Kyber realized
25.184979 USDC gross and LI.FI 25.096976 USDC gross from 0.01 WETH, both without an input remainder.
The full suite also passed direct Uniswap V2/V3 and Velodrome V2 routes, WETH-to-ETH passthrough,
the mixed DAI/USDC/OP/WETH batch, real Permit2 witness and replay checks, atomic output-floor
rollback, restored Permit2 nonces, and isolated failed-leg refunds.

## Repeating the check

```powershell
cd C:\dustswap\packages\contracts
./script/VerifyOptimismAggregatorBasket.ps1
```

The helper fetches ten public Kyber quotes and ten built payloads, paced at least 300 ms apart,
checks assets/amount/target/native-value policy, writes an ignored fixture under `out/`, then runs
the local fork case. It fails if the opted-in test fails, skips or is missing. No signing or
broadcast occurs. Process-local test variables are restored afterward.

To combine fresh fixtures at one block, build the basket fixture first, read its `forkBlock`, then:

```powershell
./script/VerifyOptimismAggregators.ps1 -ForkBlock 158154661
$env:DUST_SWEEP_OPTIMISM_FORK_TESTS = '1'
$env:DUST_SWEEP_OPTIMISM_AGGREGATOR_FORK_TESTS = '1'
$env:DUST_SWEEP_OPTIMISM_AGGREGATOR_BASKET_FORK_TESTS = '1'
$env:OPTIMISM_FORK_BLOCK = '158154661'
forge test --match-contract DustSwapSweepRouterOptimismForkTest --evm-version cancun -vv
```

Substitute the newly generated basket's block for `158154661`. Quote APIs read current state, so
fresh payloads targeting an older fork can fail if prices, pools or protocol deployments changed.
Such failures remain visible. Without the opt-in variables, these network-dependent cases report
explicit skips.

This proof is limited to the tested assets, amounts, payloads and fork state. It does not establish
that every quoted asset transfers successfully or that every current/future route can execute.
No production router was deployed or configured.
