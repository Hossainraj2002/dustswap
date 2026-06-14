---
title: "Swap & Bridge Fees"
---

# Swap & Bridge Fees

## Swap fees

Swaps are routed through DustSwap's on-chain aggregator router (in partnership with OpenOcean), which applies a DustSwap fee that is **hard-capped on-chain at 3%** (`MAX_FEE_BPS = 300`).

To be confirmed before publication: the exact live fee percentage currently shown to users (the on-chain configurable value may be set below the 3% cap).

## Bridge fees

The [Bridge](bridge.md) feature is not live yet. Fees will be documented here once the feature launches.

> **User Safety Note**
> The 3% figure is a smart-contract hard cap, not necessarily the fee you'll pay — always check the fee line in your quote before confirming a swap.

## Related pages

- [Swaps](swaps.md)
- [DustSweep Fees](../dustsweep/fees.md)
