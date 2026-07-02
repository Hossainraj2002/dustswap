---
title: "Spin Rewards"
---

# Spin Rewards

Spin is a bonus PP mini-game tied to your daily check-in.

## How it works

- Every [daily check-in](daily-check-in.md) grants **3 spin tickets**.
- Each spin costs **1 ticket**.
- **Every spin wins** a Particle Points prize from a weighted table ranging **50–500 PP**.
- Spinning requires a small on-chain transaction (a trigger transaction) that DustSwap verifies on-chain before drawing your prize. The actual prize draw happens server-side.

## Rewards table

| Prize (PP) | Notes |
|---|---|
| 50–500 | Weighted random — higher prizes are rarer, but every spin pays out something. |

## Fairness disclosure

The on-chain trigger transaction proves you spent a real ticket and prevents spinning without paying gas, but the prize draw itself is performed **server-side** — it is not provably fair on-chain. DustSwap discloses this openly: spins are a bonus feature on top of guaranteed daily PP, not a gambling product.

## FAQ

**Do spin tickets expire?**
Tickets stay in your balance until you spend them on a spin.

**Are spin prizes affected by my streak boost?**
No — spin prizes are paid as listed; the streak boost applies to your check-in and activity PP, not to spin prizes.

## Related pages

- [Daily Check-In & Streaks](daily-check-in.md)
- [PP Rewards](pp-rewards.md)
- [PP FAQ](pp-faq.md)
