---
title: "Supported Wallets Overview"
---

# Supported Wallets Overview

DustSweep supports virtually every wallet — support is based on what a wallet can do, not its brand. The difference between wallets is only how smooth the experience is: one confirmation, or a signature plus a transaction.

## How support works

DustSweep checks two capabilities, nothing else:

1. **Can it sign EIP-712 typed data?** Required for the Permit2 signature flow. Nearly every modern wallet can. If a wallet cannot, DustSweep shows a clear notice and suggests switching wallets — this is the only true "unsupported" case.
2. **Can it batch atomically (EIP-5792)?** Optional. If yes, you get [One-Click Sweeps](one-click-sweeps.md); if no, [Sign & Sweep](sign-and-sweep.md).

It also reads your account's EIP-7702 delegation state on Base, because an account upgraded by one wallet will not batch in another — see [EIP-7702 Explained](eip-7702-explained.md).

## Wallet experience matrix

Behavior reflects the current implementation; wallet capabilities change frequently and the full matrix should be re-verified before publication.

| Wallet | Expected experience |
|---|---|
| **Coinbase Wallet / Base Account** | One-click batch. ≤10 tokens: one prompt; larger sweeps: two prompts (approvals, then sweep). Possible gas sponsorship via paymaster. |
| **OKX Wallet** | One-click batch, including after OKX's own account upgrade. |
| **MetaMask** | Sign & Sweep by default (approval batching is intentionally disabled for MetaMask as a safety measure). MetaMask Smart Account delegates are recognized. |
| **TokenPocket** | Batch-style flow with special handling: approvals batched first with explicit gas, then the sweep. |
| **Uniswap Wallet, Ambire** | Recognized one-click (EIP-7702) wallets. |
| **Bitget Wallet** | EIP-7702 requires manual binding inside Bitget (More → EIP-7702 → Bind); until then, Sign & Sweep. |
| **Rainbow, Trust Wallet** | Sign & Sweep. Their account-upgrade delegates are recognized for labeling, but one-click is not promoted until their batching support is verified. |
| **Rabby** | Sign & Sweep (no public atomic batching exposed). |
| **Phantom, Zerion, imToken, Crypto.com, Safe** | Sign & Sweep. |
| **WalletConnect (any wallet via QR)** | Sign & Sweep, subject to the connected wallet's capabilities. |

## Why MetaMask batching is off by default

MetaMask can batch via its Smart Account upgrade, but DustSweep currently ships with MetaMask approval batching disabled as a deliberate safety choice, showing: *"MetaMask approval batching is disabled for safety. Approve tokens one by one, then DustSweep will send one sweep transaction."* MetaMask users get the same end result through Sign & Sweep.

## If your wallet is "blocked"

Only wallets that cannot sign typed data at all are blocked — they cannot use Permit2, batching, or anything else DustSweep relies on. The notice is inline (never a hard screen-block) and offers a switch-wallet action.

> **User Safety Note**
> Whatever the wallet, the on-chain rules are identical: exact-amount approvals only, a fee capped at 3%, and automatic refunds for failed tokens. A smoother wallet experience never means weaker protections.

## FAQ

**Which wallet gives the best experience?**
Currently the smoothest flows are Coinbase Wallet / Base Account and OKX (one confirmation). Everything else is typically one signature + one transaction.

**My wallet batches on other apps but not here. Why?**
Most often your account is delegated to a different wallet (see [EIP-7702 Explained](eip-7702-explained.md)), or your wallet's batching is gated off for reliability.

**Do hardware wallets work?**
Through a software wallet interface that supports EIP-712 signing (e.g. MetaMask + Ledger), yes — via Sign & Sweep.

## Related pages

- [Connecting Your Wallet](connecting-your-wallet.md)
- [One-Click Sweeps (EIP-5792)](one-click-sweeps.md)
- [Sign & Sweep (Permit2)](sign-and-sweep.md)
- [EIP-7702 Explained](eip-7702-explained.md)
