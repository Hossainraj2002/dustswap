---
title: "Security Overview"
---

# Security Overview

DustSwap's security model spans DustSweep, swaps, burns, spins, and the points/referral system. Key cross-cutting principles:

- **Non-custodial contracts.** Swap, sweep, burn, and spin actions are user-initiated transactions — you sign every action that moves your assets. Reward vaults are owner-managed but do not hold user funds beyond their stated purpose. See [Non-Custodial Design & Approvals](../dustsweep/non-custodial-design.md) (DustSweep-specific) and [Wallet Permissions](wallet-permissions.md).
- **On-chain fee caps.** DustSweep's sweep routers enforce a hard-capped fee on-chain (3% maximum). The swap fee is applied through OpenOcean's referrer mechanism. See [Swap & Bridge Security](../swap-and-bridge/security.md) and [DustSweep Security Model](../dustsweep/security-model.md).
- **Server-side verification of rewards.** Every action that pays Particle Points — swaps, sweeps, burns, spins, quests, referrals — is independently verified against real on-chain transactions or OAuth-linked accounts before any reward is credited. You cannot fake a reward by submitting arbitrary data.
- **Off-chain points.** Particle Points are a database-tracked balance, not a token — see [Risk Disclosures](risk-disclosures.md).
- **Allowlisted routers only.** DustSweep's sweep contracts can only call pre-approved DEX routers — see [DustSweep Security Model](../dustsweep/security-model.md).

## Related pages

- [User Safety](user-safety.md)
- [Wallet Permissions](wallet-permissions.md)
- [Risk Disclosures](risk-disclosures.md)
- [Audit Status](audit-status.md)
