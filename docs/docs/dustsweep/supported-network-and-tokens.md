---
title: "Supported Network & Tokens"
---

# Supported Network & Tokens

DustSweep runs on Base mainnet only. It can sweep almost any ERC-20 token with real liquidity on Base, and pays out in ETH, USDC, WETH, or USDT.

## Network

| | |
|---|---|
| Network | **Base mainnet** |
| Chain ID | **8453** |
| Gas token | ETH (on Base) |
| Block explorer | [https://basescan.org](https://basescan.org) |

If your wallet is on another network, DustSweep prompts a switch to Base. Discovery, quotes, and the sweep contracts are all Base-only in this release.

## Input tokens (what you can sweep)

DustSweep is **wallet-first**: it scans every ERC-20 balance you hold rather than working from a fixed token list. A token is sweepable when all of the following hold:

- It is an ERC-20 on Base with a non-zero balance in your wallet.
- It has a reliable USD price (from market data sources).
- Its value is at least **$0.01**.
- It has DEX liquidity on Base so a route can be found.
- It is not flagged by spam/scam heuristics.

Tokens that miss any of these checks still appear in the interface, grouped under hidden, suspicious, or unavailable — with the reason shown. See [Why Some Tokens Can't Be Swept](why-some-tokens-cant-be-swept.md).

**Native ETH cannot be a sweep input.** ETH must be wrapped to WETH first; the sweep contract works with ERC-20s only. (ETH *can* be your output — see below.)

## Output tokens (what you receive)

| Token | Notes |
|---|---|
| **ETH** (native) | Default output. The contract swaps into WETH and unwraps to ETH at the end. |
| **USDC** | Native Base USDC. |
| **WETH** | Wrapped Ether on Base (`0x4200000000000000000000000000000000000006`). |
| **USDT** | Tether USD on Base. |

The output list is intentionally short and limited to major assets. This removes a common scam pattern — being tricked into "sweeping into" a worthless token — and keeps quotes reliable.

## Where the liquidity comes from

Each selected token is quoted across Base's main DEXes, and the best route wins per token:

- Uniswap V3 and Uniswap V4
- Aerodrome (classic and Slipstream concentrated liquidity)
- PancakeSwap V3
- QuickSwap (Algebra)
- AlienBase
- BaseSwap

If a token can't be traded on any of those, DustSweep falls back to an external aggregator — 0x first, then LI.FI — but only for that one token. Aggregators are never used when a native DEX already has a route. The result is coverage close to all of Base's liquidity, while the common tokens still route directly through the DEXes above.

Only routers on DustSweep's allowlist can ever be called by the sweep contract. See [Security Model](security-model.md).

## Limits

- **Up to 50 tokens per sweep** (smart-contract limit). Larger wallets simply sweep more than once.
- **One network (Base)** — other chains: to be confirmed before publication; nothing is currently committed.
- **WETH → native ETH** is not currently supported as a direct sweep (the contract does not allow input = output; an unwrap-only step is not implemented yet).

## FAQ

**Will other networks be added?**
To be confirmed before publication. The current system is built specifically for Base.

**Can I sweep NFTs?**
No. DustSweep handles ERC-20 tokens only.

**Can I choose a custom output token?**
Not currently — outputs are limited to ETH, USDC, WETH, and USDT for