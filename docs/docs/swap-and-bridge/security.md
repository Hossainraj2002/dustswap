---
title: "Swap & Bridge Security"
---

# Swap & Bridge Security

## Swaps

- The on-chain aggregator router enforces a **hard-capped 3% fee** (`MAX_FEE_BPS = 300`) — this cannot be exceeded regardless of configuration.
- After a swap, DustSwap verifies your transaction on-chain before crediting volume or PP — submitting a fake or unrelated transaction hash cannot generate rewards.
- Routing is provided in partnership with **OpenOcean**, aggregating across audited Base DEX liquidity.
- Slippage protection is applied per-quote — review the quote before confirming.

## Bridge

The [Bridge](bridge.md) feature is not live yet. Its security model — expected to follow the same "your transaction is independently verified before rewards are credited" pattern — will be documented in full at launch, in partnership with OpenOcean.

## Related pages

- [Swaps](swaps.md)
- [Security Overview](../security/security-overview.md)
