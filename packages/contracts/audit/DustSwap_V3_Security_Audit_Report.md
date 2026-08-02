---
description: >-
  Security audit of the DustSwapSweepRouter (DustSweep V3) smart contract.
  Automated-tooling-assisted review with manual analysis.
---

# DustSwap V3 — Smart Contract Security Audit

{% hint style="info" %}
**Review type:** Automated tooling with manual analysis · **Date:** 13 June 2026 · **Chain:** Base (chainId 8453)
**Contract:** `DustSwapSweepRouter` (DustSweep V3)
**Tools used:** Slither · Solhint · Surya · Mythril · solc `0.8.24`
{% endhint %}

## About this audit

This report documents an internal security review of the `DustSwapSweepRouter` smart contract, performed using an industry-standard auditing toolchain combined with manual, function-by-function analysis.

The review used the following tools:

| Tool | Version | Purpose |
|---|---|---|
| **Slither** | 0.11.5 | Static analysis (101 detectors: reentrancy, access control, etc.) |
| **Solhint** | 6.2.1 | Security & style linting |
| **Surya** | 0.4.13 | Architecture, call-graph & visibility mapping |
| **Mythril** | 0.24.8 | Symbolic execution (SWC-tagged exploit modules) |
| **solc** | 0.8.24+commit.e11b9ed9 | Compiler (exact match to the deployed verify settings) |

Alongside the automated pass, every function was reviewed by hand against an auditor checklist covering access control, reentrancy (single-/cross-function and read-only), arithmetic & accounting, oracle/MEV exposure, token quirks (fee-on-transfer, missing return values), approval hygiene, denial-of-service, and economic logic.

{% hint style="warning" %}
**Scope & limitations.** This review covered the `DustSwapSweepRouter` contract source. It did **not** include dynamic fuzzing / invariant testing (Foundry, Echidna, Medusa), mainnet-fork testing against live integrations, or the off-chain route builder, signer, and frontend. It is a static + symbolic + manual review and is **not a guarantee of the absence of vulnerabilities.** See the [Disclaimer](#disclaimer).
{% endhint %}

## Scope

| Item | Detail |
|---|---|
| **Contract** | `DustSwapSweepRouter` |
| **Source** | `packages/contracts/remix/DustSwapSweepRouter_Remix.sol` (flattened) |
| **Compiler** | solc `0.8.24`, EVM `cancun`, optimizer enabled (200 runs) |
| **Target chain** | Base (chainId 8453) |
| **Out of scope** | OpenZeppelin libraries, Permit2, off-chain route builder / signer, deployment scripts, frontend |

## Executive summary

`DustSwapSweepRouter` is a best-effort, multi-DEX **dust sweep** router. It pulls many small ERC-20 balances from a user — via Permit2 SignatureTransfer or a plain allowance `transferFrom` — routes each through an allowlisted swap target, and settles the proceeds into a single output token (ERC-20 or native ETH), minus a protocol fee.

The contract is built with strong security fundamentals: hard per-sweep **exact-amount approvals** with an immediate reset to zero (no infinite or standing allowances), a **self-only `executeRoute`** wrapped in `try/catch` for fault-tolerant batching, **snapshot-delta refund accounting** that protects pre-existing balances, a **reentrancy guard** on the entrypoint, a **pause** switch, and a **hard fee cap** (`MAX_FEE_BPS` = 3%).

The automated toolchain found **no exploitable issues** — every static/symbolic flag resolved to a documented design choice or a false positive. The substantive findings are in **economic and authorization logic**, the area automated tools are weakest at.

{% hint style="success" %}
**No Critical or High severity issues were identified.** User funds are well protected by the exact-approval model and the reentrancy guard. The headline issue is protocol-side fee revenue, not user-side theft.
{% endhint %}

The review identified **1 Medium**, **5 Low**, and several **Informational** findings.

## Findings summary

| ID | Title | Severity | Status |
|---|-------|----------|--------|
| [M-1](#m-1-protocol-fee-is-caller-controlled-and-bypassable) | Protocol fee is caller-controlled and bypassable | 🟠 Medium | Open |
| [L-1](#l-1-target-and-spender-allowlists-are-validated-independently) | `target`/`spender` allowlists validated independently | 🟡 Low | Open |
| [L-2](#l-2-held-balance-guard-uses-absolute-balance) | Held-balance guard uses absolute, not per-sweep, balance | 🟡 Low | Open |
| [L-3](#l-3-slippage-floor-is-checked-on-gross-output) | Slippage floor checked on gross (pre-fee) output | 🟡 Low | Open |
| [L-4](#l-4-single-step-ownership) | Single-step ownership for a broadly privileged contract | 🟡 Low | Open |
| [L-5](#l-5-settlement-transfers-can-revert-the-whole-sweep) | Settlement transfers can revert the whole sweep | 🟡 Low | Open |
| [I-1…I-6](#informational--gas-notes) | Informational & gas notes | ⚪ Info | Open |

## Severity methodology

Severity = **Impact × Likelihood**, the model used by Immunefi, Code4rena, Sherlock, and Trail of Bits.

| Impact ＼ Likelihood | High | Medium | Low |
|---|---|---|---|
| **High** | Critical | High | Medium |
| **Medium** | High | Medium | Low |
| **Low** | Medium | Low | Low / Info |

## System overview

### Architecture

A single contract inheriting OpenZeppelin `Ownable`, `ReentrancyGuard`, and `Pausable`, with one external entrypoint, `sweep(...)`:

1. **Validation & fee resolution** — `_resolveFeeBps`, `_validateParams`, `_validateRoutes`.
2. **Pull & execute** — `_pullAndExecute` snapshots unique input balances, pulls inputs (Permit2 or `transferFrom`), runs each route best-effort via `try this.executeRoute(...)`, then refunds leftovers.
3. **Per-leg execution** — `executeRoute` (external, self-only) checks held balance ≥ `amountIn`, sets an exact approval, performs the swap `target.call(data)`, then resets all approval rails to zero regardless of outcome.
4. **Settlement** — `_settleOutput` measures the output-token balance delta, enforces `minAmountOut`, takes the fee, and delivers net output to the recipient.

### Trust model

* **Owner** (trusted) — sets fees, the fee collector, and the `allowedTargets` / `allowedSpenders` allowlists; can pause and rescue funds. The owner is highly privileged; the safety of the arbitrary-call mechanism rests on careful allowlist curation.
* **User / caller** (untrusted) — supplies routes (including swap calldata, constrained to allowlisted targets/spenders), parameters, and a signed Permit2 witness.
* **External** (untrusted) — input/output tokens and DEX targets, mitigated by the allowlist and exact approvals.

### Key invariants

1. The router never grants more allowance than `route.amountIn`, and never leaves a non-zero standing allowance after a leg.
2. A caller only ever pulls / is refunded **their own** tokens; pre-existing balances are never returned to a sweep caller.
3. A failed leg is skipped and refunded — one bad token can't brick the batch.
4. The fee never exceeds `MAX_FEE_BPS` (3%).
5. `sweep` is non-reentrant and respects the pause switch.

Invariants 1, 3, 4, 5 hold. Invariant 2 has a narrow exception when stuck balances exist (see L-2). The fee is *capped* but not *floored* (see M-1).

## Detailed findings

### M-1 · Protocol fee is caller-controlled and bypassable

{% hint style="warning" %}
**Severity: Medium** — Impact: Medium (ongoing loss of protocol fee revenue; no user-fund risk) · Likelihood: High (any caller, one parameter, no preconditions). *If fee revenue is core to the protocol, treat as High.*
**Status: Open**
{% endhint %}

**Location:** `SweepParams.feeBpsOverride`; `_resolveFeeBps`; fee charged in `_settleOutput`.

**Description.** The effective fee is taken directly from the caller-supplied `feeBpsOverride`, with only an **upper** bound and no lower bound or authorization:

```solidity
function _resolveFeeBps(uint16 feeBpsOverride) internal view returns (uint16 effectiveFeeBps) {
    effectiveFeeBps = feeBpsOverride == FEE_OVERRIDE_SENTINEL ? feeBps : feeBpsOverride;
    if (effectiveFeeBps > MAX_FEE_BPS) revert FeeTooHigh();   // upper bound only — no floor
}
```

Permit2 mode does not fix this: the witness binds the fee *the caller chose*, so a user simply signs `feeBpsOverride = 0`. In Allowance mode there is no signature at all.

**Impact.** Any caller invoking `sweep` directly with `feeBpsOverride = 0` pays zero protocol fee while receiving the full swap output. Atomic, repeatable, zero cost — fee revenue trends to zero for any sophisticated user.

**Recommendation.** Decide who may *lower* the fee and enforce it on-chain:

1. Remove the override and always use the stored `feeBps`; or
2. Floor it: `if (effectiveFeeBps < feeBps) revert FeeTooLow();` so an override can only raise the fee; or
3. If per-sweep discounts are a product need, require an owner/relayer signature authorizing the reduced fee.

---

### L-1 · `target` and `spender` allowlists are validated independently

{% hint style="info" %}
**Severity: Low** — Impact: Medium–High *if* an unsafe target/spender is ever allowlisted · Likelihood: Low (requires owner mis-curation). The most important item to get right operationally.
**Status: Open**
{% endhint %}

**Location:** `_validateRoutes` (independent `allowedTargets` / `allowedSpenders` checks); `executeRoute` (`target.call(route.data)` with attacker-controlled `data`).

**Description.** Two independent allowlists mean any allowlisted `target` can be paired with any allowlisted `spender`, and **arbitrary calldata** is executed against the target with the router as `msg.sender`. Safety reduces entirely to: *every allowlisted target is safe to call with arbitrary data, in any combination, while holding an exact-amount approval.* That assumption is easy to violate — e.g. allowlisting a router exposing a generic `multicall` / `sweepToken` helper, a token contract, the router's own address, or an EOA.

**Impact.** No exploit exists against a correctly curated allowlist (pure-swap DEX targets). The risk is realized through operational error: a single mis-allowlisted contract could let crafted calldata move the in-flight `amountIn` to an attacker-chosen destination. Blast radius is bounded to one leg's `amountIn` per call.

**Recommendation.**

* Whitelist **(target, spender) pairs** rather than two independent sets.
* Optionally constrain the **function selector** per target instead of accepting arbitrary `data`.
* Maintain an allowlisting runbook: never allowlist contracts with arbitrary-execution surfaces, the router itself, EOAs, or token contracts.

---

### L-2 · Held-balance guard uses absolute balance

{% hint style="info" %}
**Severity: Low** — Impact: Low–Medium (bounded leakage of tokens already considered "stuck") · Likelihood: Low (requires a pre-existing balance of the swept token).
**Status: Open**
{% endhint %}

**Location:** `executeRoute` held-balance check vs. the snapshot-delta model in `_snapshotInputs` / `_refundLeftoverInputs`.

**Description.** The fee-on-transfer protection checks the router's **total** balance of `tokenIn`, not the amount this sweep delivered:

```solidity
if (tokenIn.balanceOf(address(this)) < route.amountIn) revert InsufficientHeldBalance();
```

If the router holds a pre-existing balance `P` of `tokenX` (stuck tokens awaiting rescue) and a user sweeps `tokenX` as a fee-on-transfer input where only `A' < A` arrives, the guard passes when `P ≥ A − A'`. The leg then swaps the full `A`, consuming `A − A'` of the stuck balance into the caller's output. Snapshot-delta refunds don't detect this because the balance only *decreased*.

**Impact.** A user can convert stuck balances of a fee-on-transfer token into output they receive, bypassing owner rescue. Bounded by the stuck amount; only possible when stuck balances exist.

**Recommendation.** Make the held-balance guard consistent with the snapshot-delta model: capture each token's balance just before its pull and operate on the **delta actually received** (`min(amountIn, received)`), rather than the total balance.

---

### L-3 · Slippage floor is checked on gross output

{% hint style="info" %}
**Severity: Low** — Impact: Low (recipient receives slightly less than the stated floor; no theft) · Likelihood: High (every sweep with a non-zero fee).
**Status: Open**
{% endhint %}

**Location:** `_settleOutput`.

**Description.** `minAmountOut` is enforced against **gross** output, but the recipient receives **net** (gross − fee):

```solidity
grossAmountOut = balanceOf(actualOutput) - st.initialOutputBalance;
if (grossAmountOut < params.minAmountOut) revert InsufficientOutput();  // floor on GROSS
feeAmount    = (grossAmountOut * st.effectiveFeeBps) / BPS_DENOMINATOR;
netAmountOut = grossAmountOut - feeAmount;                               // recipient gets NET
```

A user setting `minAmountOut` as "the least I'll accept" can actually receive `minAmountOut − fee`. A correctness/UX gap rather than a security hole.

**Recommendation.** Either check the floor on the delivered amount (`if (netAmountOut < params.minAmountOut) revert InsufficientOutput();`), or clearly document that `minAmountOut` is a *gross* floor and have the signer/UX set it accordingly.

---

### L-4 · Single-step ownership

{% hint style="info" %}
**Severity: Low** — Impact: High if triggered (admin functions become permanently uncallable) · Likelihood: Low (requires an owner mistake).
**Status: Open**
{% endhint %}

**Location:** `Ownable` (OpenZeppelin single-step `transferOwnership`).

**Description.** The owner controls fees, the allowlists (the core security control), pause, and rescue. Plain `Ownable` transfers ownership in a single step — a transfer to a wrong address immediately and irreversibly hands over or bricks all admin power.

**Recommendation.** Use `Ownable2Step` (propose + accept), and run the owner as a multisig / timelock in production. A timelock on the allowlist and rescue setters is worth considering.

---

### L-5 · Settlement transfers can revert the whole sweep

{% hint style="info" %}
**Severity: Low** — Impact: Medium (temporary denial of service for an output token / recipient) · Likelihood: Low.
**Status: Open**
{% endhint %}

**Location:** `_settleOutput` (fee transfer, native send, ERC-20 delivery).

**Description.** The route loop is best-effort, but settlement is all-or-nothing. If `feeCollector` is blacklisted by the output token (e.g. a USDC blacklist), or the token reverts on transfer to the collector, **every** sweep into that output token reverts. If a native `recipient` rejects ETH, that sweep reverts.

**Recommendation.** Consider a pull-payment pattern for fees (accrue per-token, let the collector withdraw) so a collector/token issue can't block users; and/or fall back to WETH delivery when a native send fails. At minimum, document that `feeCollector` must be transfer-compatible with all supported output tokens.

## Informational & gas notes

* **I-1 — CEI ordering.** `_settleOutput` emits events after external transfers. Benign (the flow is `nonReentrant`), but tightening to checks-effects-interactions is good hygiene.
* **I-2 — Unindexed event parameters.** Several events have non-indexed address/amount parameters; indexing key addresses improves off-chain filtering.
* **I-3 — Centralization.** `rescueERC20` / `rescueNative` let the owner move any non-in-flight balance; combined with allowlist and fee control this is significant trust (mitigated by atomicity and the refund model). Pair with L-4 and disclose to users.
* **I-4 — Fee/slippage semantics.** See L-3; documenting the gross-vs-net convention removes ambiguity for integrators.
* **I-5 — Gas (low priority).** Struct field packing and strict-inequality micro-optimizations. Cosmetic; not worth chasing at the expense of clarity in a security-sensitive contract.
* **I-6 — Coverage gap.** No fuzzing / invariant or fork testing was performed. The invariants above are strong candidates for a Foundry/Echidna suite.

### Triaged automated findings (false positives / by design)

| Tool finding | Disposition |
|---|---|
| Slither `arbitrary-send-eth` (`_settleOutput`) | **By design** — ETH is sent to the user-specified recipient; the function is `nonReentrant`. |
| Slither `uninitialized-local` (`SweepState`) | **False positive** — struct is zero-initialized, then every used field is set before read. |
| Slither `incorrect-equality` (`_refundLeftoverInputs`) | **By design** — intentional SafeERC20-style handling of non-compliant return data. |
| Slither `calls-in-loop` | **Acceptable** — loop bounded by `MAX_BATCH_SIZE` = 50; route loop is intentionally best-effort. |
| Slither `assembly` | **From OpenZeppelin / standard**, memory-safe. |
| Slither/Solhint `timestamp` | **Acceptable** — used only for the deadline check. |
| Solhint `avoid-low-level-calls` | **By design** — raw `.call` is required for the swap leg and fault-tolerant refunds. |
| Mythril (EtherThief, ArbitraryStorage, ArbitraryDelegateCall, UncheckedRetval) | **No issues detected.** |

## Recommended actions

1. **Resolve M-1** — decide the fee-override policy and enforce a floor (or remove the override).
2. **Harden L-1** — move to (target, spender) pair allowlisting and/or per-target selector restrictions; publish an allowlisting runbook.
3. **Address L-2 / L-3** — make held-balance and slippage checks delta/net-consistent.
4. **Adopt `Ownable2Step` + multisig/timelock** (L-4) and disclose centralization (I-3).
5. **Add an invariant/fuzz suite and fork tests** against the live allowlisted targets (I-6).

## Disclaimer

This report was produced internally using the tools listed above together with manual analysis, and reflects the state of the reviewed source at the time of review. It is an automated-tooling-assisted security review, **not** a third-party professional audit, and **not** a guarantee of the absence of vulnerabilities. It did not include dynamic fuzzing, invariant testing, or fork testing.

Smart-contract security is an ongoing process. Re-review after any change, complete the dynamic-analysis coverage noted above, consider a full third-party audit and a bug bounty, and operate with a timelock/multisig in production. Use of this contract is at your own risk.
