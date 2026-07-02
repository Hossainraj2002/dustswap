---
title: "Related Contracts"
---

# Related Contracts

Beyond the DustSweep router itself, DustSwap's on-chain footprint on Base mainnet includes:

| Contract | Address | Used for |
|---|---|---|
| Permit2 (canonical Uniswap deployment) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Sign-and-sweep approvals (see [Sign & Sweep](../dustsweep/sign-and-sweep.md)) |
| WETH (Base) | `0x4200000000000000000000000000000000000006` | Wrapping/unwrapping ETH during sweeps and swaps |
| DustSpinTrigger | `0xCf10Edbc886C60086e49061c807a14E7009F9A22` | On-chain trigger for [Spin Rewards](../rewards/spin-rewards.md) |

## Allowlisted DEX routers (DustSweep)

DustSweep's sweep contracts can only route through these allowlisted DEX routers on Base:

| Router | Address |
|---|---|
| Uniswap Universal Router (V3+V4) | `0x6fF5693b99212Da76ad316178A184AB56D299b43` |
| Uniswap V3 SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Aerodrome Universal Router | `0x6Cb442acF35158D5eDa88fe602221b67B400Be3E` |
| Aerodrome Classic Router (Solidly) | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| Aerodrome Slipstream SwapRouter | `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` |
| PancakeSwap SmartRouter | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` |
| QuickSwap Algebra SwapRouter | `0xe6c9bb24ddB4aE5c6632dbE0DE14e3E474c6Cb04` |
| AlienBase Router (UniV2) | `0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7` |
| DackieSwap SmartRouter | `0x195FBc5B8Fbd5Ac739C1BA57D4Ef6D5a704F34f7` |
| BaseSwap Router | `0x327Df1E6de05895d2ab08513aaDD9313Fe505d86` |

AlienBase trades go through its UniV2 router above, not the AlienBase SmartRouter — the SmartRouter doesn't expose an on-chain quote, so DustSweep doesn't use it.

## Aggregator fallback targets (DustSweep)

When no DEX above can trade a token, DustSweep can route that one token through an external aggregator. Only these outer aggregator contracts are allowlisted — never the individual pools or internal hops they use:

| Aggregator | Address |
|---|---|
| 0x AllowanceHolder | `0x0000000000001fF3684f28c67538d4D072C22734` |
| LI.FI Diamond | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |

> **User Safety Note**
> Only the contracts above (and the DustSweep router on the [previous page](dustsweep-router.md)) are part of DustSwap. Verify any address against this page or BaseScan before interacting with it.

## Related pages

- [DustSweep Router](dustsweep-router.md)
- [Supported Networks (Contracts)](supported-networks.md)
- [DustSweep Security Model](../dustsweep/security-model.md)
