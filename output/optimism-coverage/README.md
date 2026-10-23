# Optimism representative liquidity measurement

Measured **2026-10-13 15:58:36–15:59:37 UTC**. On-chain metadata reads were pinned to OP
Mainnet block **158154170**. The public quote APIs read their current state independently.

The basket contains **20 deployed tokens**: 19 entries from the current official Optimism token
list, plus the current VELO V2 token from Velodrome's official deployment table. The official list
contains **195 OP Mainnet entries**. This is a deliberate representative sample, not a random
sample or evidence that most/all OP tokens can be swept.

All 20 tokens passed bytecode, readable name/symbol and decimals checks. The USDC.e display label
maps to an on-chain symbol of `USDC`, as expected. PEPE had no price in the LI.FI price snapshot,
so dollar-sized quote attempts were omitted rather than inventing an amount.

For the other 19 inputs, the script requested amounts sized at approximately **$1 and $10** using
the recorded LI.FI price. Outputs were native Circle USDC, except native USDC input was quoted to
WETH. Both providers were queried sequentially, with at least 275 ms between requests.

| Measurement | Result |
|---|---:|
| Token metadata checks | 20 passed, 0 failed |
| Priced inputs | 19 |
| Provider quote requests | 76 |
| Positive quotes with expected target/spender/chain/value | 74 |
| No quote | 2 |
| Transport/provider errors | 0 |
| Unsafe returned target/spender/chain/value | 0 |
| Kyber | 38/38 quoted |
| LI.FI | 36/38 quoted |

| Input | Address | Kyber $1 / $10 | LI.FI $1 / $10 |
|---|---|---|---|
| AAVE | `0x76FB31fb4af56892A25e32cFC43De717950c9278` | Yes / Yes | Yes / Yes |
| DAI | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | Yes / Yes | Yes / Yes |
| LINK | `0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6` | Yes / Yes | Yes / Yes |
| LUSD | `0xc40f949f8a4e094d1b49a23ea9241d289b7b2819` | Yes / Yes | Yes / Yes |
| OP | `0x4200000000000000000000000000000000000042` | Yes / Yes | Yes / Yes |
| PEPE | `0xc1c167cc44f7923cd0062c4370df962f9ddb16f5` | Unpriced | Unpriced |
| Rocket Pool rETH | `0x9bcef72be871e61ed4fbbc7630889bee758eb81d` | Yes / Yes | Yes / Yes |
| sETH | `0xE405de8F52ba7559f9df3C368500B6E6ae6Cee49` | Yes / Yes | No / No |
| SNX | `0x8700daec35af8ff88c16bdf0418774cb3d7599b4` | Yes / Yes | Yes / Yes |
| sUSD | `0x8c6f28f2F1A3C87F0f938b96d27520d9751ec8d9` | Yes / Yes | Yes / Yes |
| UNI | `0x6fd9d7ad17242c41f7131d257212c54a0e816691` | Yes / Yes | Yes / Yes |
| USD₮0 | `0x01bFF41798a0BcF287b996046Ca68b395DbC1071` | Yes / Yes | Yes / Yes |
| Native USDC | `0x0b2c639c533813f4aa9d7837caf62653d097ff85` | Yes / Yes | Yes / Yes |
| USDC.e | `0x7F5c764cBc14f9669B88837ca1490cCa17c31607` | Yes / Yes | Yes / Yes |
| Legacy USDT | `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` | Yes / Yes | Yes / Yes |
| VELO V1 | `0x3c8B650257cFb5f272f799F5e2b4e65093a11a05` | Yes / Yes | Yes / Yes |
| VELO V2 | `0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db` | Yes / Yes | Yes / Yes |
| WBTC | `0x68f180fcCe6836688e9084f035309E29Bf0A2095` | Yes / Yes | Yes / Yes |
| WETH | `0x4200000000000000000000000000000000000006` | Yes / Yes | Yes / Yes |
| wstETH | `0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb` | Yes / Yes | Yes / Yes |

LI.FI returned HTTP 422, code 1001, for sETH at both sizes: “None of the available routes could
successfully generate a tx.” Kyber returned positive routes for the same input amounts. This is a
provider-specific result, not proof that the returned Kyber route can execute.

Kyber's returned route identifiers include Uniswap V3/V4, Velodrome V1/V2 and concentrated-liquidity
variants, Curve, Balancer V3, Solidly V3, WOOFi V3 and PMM. LI.FI's included routing tools were OKX
(29 quotes), 1inch (3), Sushi (2), Kyber (1) and Nordstern (1). These internal venues use the
canonical aggregator target/spender; they do not require direct venue allowlist entries. The
per-response identifiers and non-exclusive venue counts can be calculated from the JSON snapshot.

Price quality remains separate from quote availability. The recorded LI.FI price was approximately
$317.06 for sETH and $0.2503 for sUSD. Kyber's quoted output for the sETH amount sized as $1 was
1.732711 USDC; for its nominal $10 amount, 16.017309 USDC. These discrepancies show why the sizes
must be described as dollar amounts **based on the recorded provider price**, not independently
verified fair value or profit. Provider gas estimates also do not establish the total cost of a
multi-token DustSweep transaction.

These checks do **not** establish token transferability, built Kyber calldata execution, wallet
approval behavior, aggregate sweep output, affordability, or future liquidity. LI.FI supplied built
calldata in its quote responses; this sample did not execute it. The separate exact-router fork
suite provides execution evidence for its tested routes, rather than every asset in this basket.
No transaction was signed or broadcast.

## Evidence and repeat command

- [Machine-readable snapshot](coverage-2026-10-13T15-58-36-725Z.json)
- Script: `packages/contracts/script/MeasureOptimismCoverage.mjs`
- [Official Optimism token list](https://raw.githubusercontent.com/ethereum-optimism/ethereum-optimism.github.io/master/optimism.tokenlist.json), timestamp `2026-09-08T20:52:56.722Z`
- [Optimism token-list repository and curation scope](https://github.com/ethereum-optimism/ethereum-optimism.github.io)
- [Official VELO V2 deployment table](https://github.com/velodrome-finance/contracts/blob/main/README.md#deployment)
- [LI.FI OP token-price metadata](https://li.quest/v1/tokens?chains=10)
- [Kyber Optimism quote API](https://aggregator-api.kyberswap.com/optimism/api/v1/routes)
- [LI.FI quote API](https://li.quest/v1/quote)

```powershell
cd C:\dustswap
node packages/contracts/script/MeasureOptimismCoverage.mjs
```

Optional process variables: `OPTIMISM_MAINNET_RPC_URL` and `OPTIMISM_COVERAGE_OUTPUT_DIR`.
Each run writes a new timestamped JSON file and preserves partial progress if an individual
token/provider check fails.
