---
title: "What the Wallet Prompts Mean"
---

# What the Wallet Prompts Mean

Every prompt DustSweep triggers in your wallet has a specific, predictable shape. This page is your checklist: what each prompt is, what it should contain, and when to reject.

## The four prompt types

### 1. Network switch

*"Switch to Base?"* — Read-only network change. Safe to approve. DustSweep operates on Base only.

### 2. Token approval

*"Allow [DustSweep router / Permit2] to spend X TOKEN?"*

What a legitimate DustSweep approval looks like:

- **Amount:** the exact amount being swept — never "unlimited", never a strange round number you didn't select.
- **Spender:** the DustSweep router or the canonical Permit2 contract (`0x000000000022D473030F116dDEE9F6B43aC78BA3`).
- Some tokens (e.g. USDT-style) require a reset-to-zero approval first — you may see two prompts for one token. That is normal.

### 3. Signature request (gas-free)

*"Sign typed data: PermitBatchWitnessTransferFrom"*

What it must contain:

- Origin contract: **Permit2**.
- A list of **exactly the tokens and amounts you selected**.
- The sweep contract as spender.
- A deadline ~30 minutes ahead.

This message authorizes one specific sweep and nothing else. Details: [What You Sign and Why It's Safe](what-you-sign.md).

### 4. Transaction / batch confirmation

*"Confirm transaction"* or *"Confirm batch of N actions"*

- Target: the DustSweep router contract.
- On batching wallets, the bundle = exact-amount approvals + the sweep call.
- Your wallet may also show its own **one-time account upgrade** prompt (EIP-7702) before the first batch — that prompt is generated and branded by your wallet itself. See [One-Click Sweeps](one-click-sweeps.md).

## Quick reject checklist

Reject and stop if any prompt shows:

- ❌ An **unlimited** approval amount (DustSweep never asks for this).
- ❌ A spender/target address that is neither the DustSweep router nor Permit2.
- ❌ Tokens or amounts you did **not** select.
- ❌ A signature with no deadline, or from a contract other than Permit2.
- ❌ Any prompt on a domain other than **app.dustswap.wtf**.
- ❌ `eth_sign` / raw hex "blind signing" requests — DustSweep never uses these.

> **User Safety Note**
> Rejecting is always free and always safe. If a prompt confuses you, reject it, re-read this page, and try again. DustSweep's stepper (`Setup → Sign → Sweep`, etc.) tells you exactly how many prompts to expect — anything beyond that count deserves suspicion.

## FAQ

**My wallet shows a red/orange warning on the signature. Is that bad?**
Many wallets flag *all* typed-data requests generically. Judge the content, not the color: exact tokens, exact amounts, Permit2 origin, 30-minute deadline.

**Why two prompts for one token approval?**
Some tokens require resetting an existing allowance to zero before setting a new one. DustSweep handles this automatically.

**The wallet says it cannot estimate gas.**
Common on complex batches in some wallets. DustSweep supplies explicit gas where needed or falls back to simpler steps; if it persists, retry or reduce the token count.

## Related pages

- [What You Sign and Why It's Safe](what-you-sign.md)
- [Sign & Sweep (Permit2)](sign-and-sweep.md)
- [One-Click Sweeps (EIP-5792)](one-click-sweeps.md)
- [Non-Custodial Design & Approvals](non-custodial-design.md)
