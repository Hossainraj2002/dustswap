---
title: "Swap & Bridge"
description: "Trade tokens and move them across chains, right inside DustSwap."
---

# Swap & Bridge

Swap & Bridge is DustSwap's everyday trading surface: turn one token into another, or move a token from one chain to another, without leaving the app. It's separate from [DustSweep](../dustsweep/what-is-dustsweep.md) — DustSweep clears out tiny dust balances, while Swap & Bridge handles normal, intentional trades.

Two things live here:

- **Swap** — trade one token for another on the same chain.
- **Bridge** — move a token from one chain to another. It's the same flow as a swap, just with a different destination chain.

Under the hood, DustSwap routes through its partner OpenOcean to find a competitive price across the market instead of a single pool. From your side it stays simple: one quote, one confirmation in your own wallet.

## What it costs

A flat **0.25%** DustSwap fee on every swap and bridge — same rate either way, and always shown in your quote before you confirm. You also pay the normal network gas for the chain you're on, which DustSwap doesn't take. See [Fees](fees.md).

## What you earn

Verified swaps earn Particle Points and count toward the volume leaderboard, with your streak boost applied. Every trade is checked on-chain before any reward is credited.

## Where it runs

Swaps run on Base and the other supported chains; bridging moves tokens between them. See [Supported Networks](supported-networks.md) for the full list.

## Next

- [Swaps](swaps.md) — the step-by-step flow.
- [Supported Networks](supported-networks.md) — chains you can swap and bridge across.
- [Fees](fees.md) — the 0.25% fee, explained.
- [Security](security.md) — routing, verification, and what to check before you confirm.
