---
title: "Choosing an Output Token"
---

# Choosing an Output Token

Every sweep converts your selected tokens into one output token. DustSweep offers four: ETH (the default), USDC, WETH, and USDT.

## The options

| Output | Best for | Notes |
|---|---|---|
| **ETH** | Most users — gas and general use | Native ETH on Base. Swaps route into WETH and the contract unwraps to ETH at the very end, so you receive plain ETH. |
| **USDC** | Locking in a stable dollar value | Native Base USDC, 6 decimals. |
| **WETH** | DeFi users who need the ERC-20 form of ETH | Wrapped Ether (`0x4200…0006`). |
| **USDT** | Stable value, Tether preference | Tether USD on Base. |

## Things that happen automatically

- **Your output token is removed from the input list.** You cannot sweep USDC into USDC; if you had USDC selected and switch the output to USDC, it is deselected automatically.
- **Quotes refresh** whenever you change the output token.
- **WETH input + ETH output is currently skipped.** Converting WETH to native ETH is an unwrap, not a swap, and the sweep contract does not yet support an unwrap-only step. Sweep WETH to USDC/USDT instead, or unwrap it separately.

## Why only four tokens?

A short, fixed list of major assets:

- removes the classic scam of being lured into receiving a worthless "output" token,
- guarantees deep liquidity so quotes stay accurate, and
- keeps fee and value calculations dependable.

Custom output tokens are not currently planned for the user interface.

## FAQ

**Which output gives me the best value?**
Value differences are usually negligible — every input token independently takes its best route to your chosen output. Choose based on what you want to hold.

**I chose ETH — why does the transaction mention WETH?**
On-chain, DEXes trade WETH. The sweep contract collects WETH internally and unwraps it to native ETH before sending it to you. You receive ETH.

**Can the output go to a different address?**
The app sends the output to the connected wallet address.

## Related pages

- [Supported Network & Tokens](supported-network-and-tokens.md)
- [Understanding Your Quote](understanding-your-quote.md)
- [Scanning & Selecting Tokens](scanning-and-selecting-tokens.md)
