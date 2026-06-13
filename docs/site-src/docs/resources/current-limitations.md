# Current Limitations

- **Base mainnet only** — DustSweep, Swaps, and the points system all currently run on Base (chain ID 8453). Other networks are not currently committed.
- **Bridge is not live** — shown as "Coming soon" in the app. See [Bridge](../swap-and-bridge/bridge.md).
- **DustSweep: up to 50 tokens per sweep** per transaction (smart-contract limit).
- **DustSweep output tokens limited to ETH, USDC, WETH, USDT** — by design, to avoid "sweep into a worthless token" scams.
- **Particle Points have no monetary value today** and cannot be transferred, traded, or sold. See [Risk Disclosures](../security/risk-disclosures.md).
- **Co-Founder Pass referral boost (30%) is planned but not live.**
- **Leaderboard-based TGE rewards** are planned but not finalized (structure, amounts, timing all unannounced).
- **Spin prize draws are server-side**, not provably fair on-chain (the triggering transaction is verified on-chain).
- Several smaller open items (streak-recovery window duration, spin-ticket expiry, Footprint Drop referral-commission eligibility, off-app swap PP eligibility) are tracked in `docs/gitbook-build-audit.md` and the relevant pages, marked "to be confirmed before publication."

## Related pages

- [Risk Disclosures](../security/risk-disclosures.md)
- [Roadmap](roadmap.md)
