---
title: "Earning PP: Every Action & Cap"
---

# Earning PP: Every Action & Cap

Every way to earn Particle Points, with exact base amounts, multipliers, and daily caps. All on-chain actions are verified server-side against the real transaction before points are credited.

## The earning table

| Action | Base PP | Multiplier | Daily cap | Streak boost applies |
|---|---|---|---|---|
| Daily check-in | 100 | streak boost | once per UTC day | ✓ (it *is* the boost driver) |
| Swap | 50 per swap | — | 500 PP/day | ✓ |
| DustSweep | 50 per token swept | ×5 | 5,000 PP/day | ✓ |
| Burn | 50 per token burned | ×2 | 2,000 PP/day | ✓ |
| Bridge *(coming soon)* | 50 per token | ×10 | 10,000 PP/day | ✓ |
| Spin | 50–500 per spin | weighted prize table | limited by tickets | — |
| Quest completion | per-quest amount | — | once per quest | — |
| Referral signup | 500 (both sides) | — | per new referral | ✗ |
| Referral commission | 20% of invitee's earnings | — | — | ✗ |
| Footprint Drop | 5,000–26,000 | tiered by history | once per address | ✗ |
| Profile completion | one-time reward | — | once | — |

Notes:

- **Daily caps reset at 00:00 UTC.** Once an action's cap is reached, further activity that day earns 0 PP from that action (the activity itself still works normally).
- **The streak boost** (up to +300%) multiplies the base award of every boost-eligible action — see [Streak Boost Explained](streak-boost-explained.md). Referral bonuses and commissions are never boosted.
- **Bridge** is visible in the app as "Soon" and is not live; its rewards are pre-configured and will activate at launch.
- Profile-completion reward amount: to be confirmed before publication.

## Worked example

A user on a 10-day streak (+100% boost) sweeps 8 dust tokens:

| | |
|---|---|
| Base | 8 tokens × 50 PP = 400 PP |
| Sweep multiplier ×5 | 2,000 PP |
| Streak boost +100% | **4,000 PP** |
| Check against daily cap (5,000) | ✓ within cap — 4,000 PP awarded |

The same sweep with no streak: 2,000 PP. Consistency pays.

## How verification works

- **On-chain actions** (swap, sweep, burn, spin): the app submits your transaction hash; the backend reads the actual transaction on Base and only then credits PP. Submitting fake or duplicate hashes does nothing — each transaction can be credited once.
- **Social actions** (quests): verified through your linked X or Discord account, not screenshots.

> **User Safety Note**
> No one from DustSwap will ever ask you to send funds, share a seed phrase, or pay a fee to "unlock" PP. Earning PP never requires anything beyond using the app's own features.

## FAQ

**I hit a daily cap. Do I lose the extra points?**
Yes — activity above a cap earns no PP that day. Caps reset at 00:00 UTC.

**Do failed transactions earn PP?**
No. Only confirmed, successful transactions are credited.

**Can I earn PP for swaps made outside the DustSwap app?**
To be confirmed before publication — currently points are credited for activity recorded through the app.

## Related pages

- [What are Particle Points?](pp-rewards.md)
- [Streak Boost Explained](streak-boost-explained.md)
- [Daily Check-In & Streaks](daily-check-in.md)
- [How Referrals Work](../referrals/how-referrals-work.md)
