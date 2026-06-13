# Wallet Permissions

DustSwap's contracts are designed so you only grant the minimum access needed for the action you're performing, and every approval is visible in your wallet before you sign.

## What you may be asked to approve

- **Token approvals** (ERC-20 `approve` or Permit2 signatures) scoped to the specific tokens and amounts involved in a sweep or swap — see [Non-Custodial Design & Approvals](../dustsweep/non-custodial-design.md) for the full DustSweep breakdown.
- **Transaction signatures** for swaps, sweeps, burns, spins, and (when enabled) the streak-recovery fee payment.

## What DustSwap never asks for

- Your seed phrase or private key.
- A "verification signature" on an external site.
- Blanket/unlimited approvals beyond what a sweep or swap requires.

## Related pages

- [Non-Custodial Design & Approvals](../dustsweep/non-custodial-design.md)
- [What You Sign and Why It's Safe](../dustsweep/what-you-sign.md)
- [Security Overview](security-overview.md)
