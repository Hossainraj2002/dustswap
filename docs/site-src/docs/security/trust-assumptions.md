# Trust Assumptions

## Contract ownership

DustSweep's router contracts use OpenZeppelin's `Ownable` pattern, plus `Pausable` (an owner can pause the contract) and `ReentrancyGuard`. This means an owner key/address has administrative control over these contracts (e.g. pausing, fee configuration within the hard cap).

To be confirmed before publication: who holds the owner key(s) for each deployed contract, and whether any are managed by a multisig.

## Admin surface (off-chain)

The points/quest system is **database-driven and admin-managed**: quests can be created or edited, and Particle Points can be granted or adjusted, by DustSwap administrators. This is necessary for operating the rewards program, but it means PP balances are ultimately a database record controlled by DustSwap, not a trustless on-chain asset — consistent with the disclosure in [Risk Disclosures](risk-disclosures.md).

## Fee collection

Fees collected by the aggregator router and sweep routers are sent to a DustSwap-controlled `FeeCollector` contract.

## What this means for you

- Your **assets** during a sweep/swap/burn/spin move only via transactions you sign — contracts cannot pull funds beyond what you approved.
- Your **Particle Points balance** is an off-chain record maintained by DustSwap, with the limitations described in [Risk Disclosures](risk-disclosures.md).

## Related pages

- [Security Overview](security-overview.md)
- [Risk Disclosures](risk-disclosures.md)
- [Audit Status](audit-status.md)
