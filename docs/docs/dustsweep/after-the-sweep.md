---
title: "After the Sweep: Results, Refunds & Rewards"
---

# After the Sweep: Results, Refunds & Rewards

The sweep confirmed — here is how to read the results, what happened to any tokens that failed, and what you earn in the DustSwap rewards system.

## The success summary

After the transaction is confirmed and verified on-chain, DustSweep shows:

- Every token swept, with the DEX it routed through and its estimated contribution.
- The total output delivered, in tokens and USD.
- The protocol fee taken (2% of output).
- A **BaseScan link** to the transaction.

Your balances rescan automatically afterwards, so the swept tokens disappear from the list and your output token balance updates.

## Refunds: when a token doesn't make it

A sweep is **best-effort per token**: if one token's swap fails on-chain (thin liquidity, a price move past your slippage floor, a misbehaving token contract), the contract:

1. Skips that token's swap.
2. Returns the **full input amount to your wallet in the same transaction**.
3. Completes the rest of the sweep normally.

Nothing is stranded and nothing is sold below its floor. On BaseScan you can verify this in the transaction logs:

| Event | Meaning |
|---|---|
| `DustSwept` | Sweep settled: route count, gross output, fee, net delivered. |
| `RouteExecuted` | This token swapped successfully. |
| `RouteSkipped` | This token's swap failed and was skipped. |
| `InputRefunded` | The skipped token's amount returned to your wallet. |

> **User Safety Note**
> Refunds are automatic and happen inside the sweep transaction itself — there is no "claim refund" step, ever. Anyone contacting you offering to "process your DustSweep refund" is a scammer.

## Verifying on BaseScan

1. Open the BaseScan link from the success screen.
2. Check status **Success** and the **ERC-20 token transfers** section — you should see your inputs going in, the output coming back to your address, and the fee transfer.
3. The **Logs** tab shows the events listed above.

## Rewards

Each recorded sweep contributes to your DustSwap progression (points and quests), including quests such as: first sweep, sweeping 10+ tokens in one go, sweeping 50 tokens, sweeping $100+ of value, and completing 5 sweeps. Rewards accrue to the wallet that performed the sweep — exact point values and active quests are managed in the app and may change.

## FAQ

**I received slightly less than the estimate. Why?**
Estimates are quoted before execution; markets move within your slippage tolerance, and the 2% fee applies. The minimums you accepted are always honored.

**One token came back to my wallet. Do I need to do anything?**
No. It was skipped and refunded. You can retry it later with a fresh quote — or leave it.

**The transaction succeeded but the success screen didn't show (I closed the tab).**
The on-chain result is unaffected. Check the transaction in your wallet history or BaseScan; your tokens arrived regardless.

**Where do I see my points?**
In your DustSwap profile page, alongside quests and streaks.

## Related pages

- [Executing a Sweep](executing-a-sweep.md)
- [Slippage & Price Impact](slippage-and-price-impact.md)
- [Why Some Tokens Can't Be Swept](why-some-tokens-cant-be-swept.md)
