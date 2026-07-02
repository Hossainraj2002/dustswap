---
title: "Security Model"
---

# Security Model

DustSweep's security rests on a small set of strictly enforced on-chain rules: exact amounts only, approvals that always return to zero, allowlisted DEXes only, and accounting that makes user funds unreachable to anyone else. This page explains the model, its guarantees, and its honest trust assumptions.

## Core guarantees (enforced by the smart contract)

**1. Non-custodial, atomic execution.**
Tokens move wallet → sweep contract → DEX → wallet inside one transaction. The contract holds nothing of yours between transactions. See [Non-Custodial Design & Approvals](non-custodial-design.md).

**2. Exact amounts are the single source of truth.**
The contract pulls exactly the per-token amounts you authorized, approves each DEX for exactly that amount, and resets every approval to zero immediately after each swap — on success *and* on failure. No unlimited or standing allowance path to the router exists in any mode.

**3. Allowlisted DEXes only.**
Each swap can only call a contract on the owner-maintained allowlist (Uniswap, Aerodrome, PancakeSwap, QuickSwap, AlienBase, BaseSwap, the 0x and LI.FI aggregator contracts, and other verified Base routers), and tokens can only be pulled by allowlisted spenders. Anything else reverts on-chain. The backend additionally verifies every route against the allowlist — both its configuration and the live on-chain state — before building a transaction.

**4. Signed intent (Permit2 path).**
The signature binds the exact routes, output token, recipient, minimum output, deadline, **and fee**. Nothing can be altered after you sign without invalidating the signature. Signatures are single-use, expire in 30 minutes, and only work when submitted by your own address.

**5. Delta accounting.**
The contract measures balances before and after, and only ever credits/refunds the difference your transaction brought in. Pre-existing balances on the contract can never be swept out by another user, and your refunds cannot be claimed by anyone else.

**6. Best-effort with refunds.**
A failed swap leg is skipped and its input refunded in the same transaction — never executed at a bad price, never stranded.

**7. Reentrancy and pause protection.**
The sweep entrypoint is reentrancy-guarded; internal execution steps are callable only by the contract itself; the owner can pause the contract in an emergency.

**8. Fee cap.**
The protocol fee (currently 2%) can never exceed **3%** — enforced in the contract constructor and in every fee update.

## Trust assumptions (what you do rely on)

Honesty requires naming these:

| You trust | For what | Mitigation |
|---|---|---|
| **Contract owner** | Maintaining the DEX allowlist, setting the fee (≤3%), pause, and rescue of stuck funds | Fee hard cap; allowlist changes are public on-chain events; owner cannot touch funds inside your transaction or access your wallet |
| **DustSweep backend** | Building honest routes and tight minimum outputs from fresh quotes | Per-token slippage floors; the aggregate floor and full intent are in what you sign; failed legs refund |
| **Allowlisted DEXes** | Executing swaps correctly | Only large, established public routers are allowlisted, each verified on-chain before listing |
| **Permit2 (Uniswap)** | Signature verification and transfers | Canonical, ecosystem-wide, heavily reviewed deployment |

## Audit status

The current sweep contract has completed an **internal AI-assisted security review** (smart-contract audit methodology, including static analysis and symbolic execution): **0 critical and 0 high severity findings**; the mediums and lows are trust/operational items consistent with the design (owner-allowlist trust concentration; per-token slippage floors enforced via swap instructions rather than separate on-chain checks). A further audit pass is planned, and the published audit file will be updated when it completes.

## Known limitations, stated plainly

- Per-token minimum outputs live in the swap instructions built off-chain; the contract enforces them per leg via the DEXes plus an aggregate floor at settlement — quote freshness matters, which is why quotes expire in 30 minutes.
- The owner role is powerful (allowlist, fee within cap, pause). Owner governance hardening (multisig/timelock) is not yet in place.
- Fee-on-transfer tokens as *inputs* are detected and refunded rather than mis-swapped; exotic tokens as *outputs* are avoided by restricting outputs to ETH/USDC/WETH/USDT.

> **User Safety Note**
> No security model covers what happens outside it. The most common real-world losses come from fake websites and malicious signature prompts — verify **app.dustswap.wtf**, read prompts against [What the Wallet Prompts Mean](wallet-prompts.md), and never sign typed data you cannot account for.

## Related pages

- [Non-Custodial Design & Approvals](non-custodial-design.md)
- [What You Sign and Why It's Safe](what-you-sign.md)
- [Fees](fees.md)
- [General FAQ](faq.md)
