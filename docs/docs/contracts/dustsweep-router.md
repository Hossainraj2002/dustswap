# DustSweep Router

DustSweep has been through three on-chain router versions. The current production router is **V3**.

## Deployed addresses (Base mainnet)

| Contract | Address | Source |
|---|---|---|
| DustSweepRouter (V1, legacy) | `0x2eb53aed1f45fd6aa5c1db29531eff40e7b36949` | Foundry broadcast + env |
| DustSweepPermit2RouterV2 (V2) | `0x6d3C31E4a2b8e1Fe9De0d260D142183E82cbE1E3` | env (`DUST_SWEEP_ROUTER_V2_ADDRESS`) |
| DustSwapSweepRouter (V3, current) | `0x06e6BAa61A5Da1E4469FCa5dEa3EB68324255E20` | env (`DUST_SWEEP_ROUTER_V3_ADDRESS`) |

To be confirmed before publication: BaseScan verification status for each contract above.

## Version notes

- **V1** (`DustSweepRouter`) — legacy, Uniswap V3 only, max 10 tokens per sweep, plain approvals.
- **V2** (`DustSweepPermit2RouterV2`) — Permit2-based, all-or-nothing execution (any failed swap leg reverts the whole sweep), no native ETH output, no pause switch.
- **V3** (`DustSwapSweepRouter`, current) — adds native ETH output, pause switch, per-sweep fee override, and a fee binding in the Permit2 witness. Built with OpenZeppelin `Ownable`, `ReentrancyGuard`, and `Pausable`.

## Related pages

- [DustSweep Security Model](../dustsweep/security-model.md)
- [Related Contracts](related-contracts.md)
- [DustSweep Technical Specification (Full)](../resources/dustsweep-technical-specification.md)
