# DustSweep V2 Router — Verify on BaseScan

**Contract:** `DustSweepPermit2RouterV2`
**Address:** `0x6d3C31E4a2b8e1Fe9De0d260D142183E82cbE1E3`
**Network:** Base mainnet (chain id `8453`)
**Creation tx:** `0x50196a08ac5e3555e535c67bdff63852dcd6092bff2f045698561bd45e7cbd23`

---

## The two errors you hit — and the fix

**Error 1 — `@openzeppelin ... import callback not supported`.**
You were compiling/pasting the version of the contract that still has `import "@openzeppelin/..."` lines at the top. A standalone compiler (BaseScan's paste box, or that verify path) can't fetch those files, so it errors. **Fix: use the flattened file** that has every dependency inlined and zero external imports — `DustSweepPermit2RouterV2_flattened.sol` (now in your folder). I compiled it locally with the exact deployment compiler and it reproduces the on‑chain bytecode byte‑for‑byte, so it's the correct file.

**Error 2 — `constructor argument` / `bytecode does NOT match`.**
Your contract is **already verified on Sourcify and Blockscout**, so the source is right — BaseScan just does one extra check: it matches the **constructor arguments** against the creation transaction. Supply the exact ones below and keep optimization **off**.

> Two non‑negotiables: (1) the **flattened** file (no imports), and (2) optimization **disabled**. Get those right and it verifies.

---

## Exact settings — these MUST match the deployment

| Setting | Value |
|---|---|
| Compiler version | `v0.8.34+commit.80d5c536` |
| Optimization | **Disabled** (do NOT enable it) |
| EVM version | `default` (compiler default) |
| License | MIT |
| Contract name | `DustSweepPermit2RouterV2` |

> The most common mistake is leaving **Enable optimization** checked. The on‑chain contract was compiled with optimization **OFF**. Keep it off.

---

## Constructor arguments

Decoded (what they mean):

| # | Parameter | Value |
|---|---|---|
| 1 | `_permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical Permit2) |
| 2 | `_owner` | `0xB4Cc7bFDd62b6FaA6c24ff01C597b085Dfadf470` (your deployer wallet) |
| 3 | `_feeCollector` | `0xB4Cc7bFDd62b6FaA6c24ff01C597b085Dfadf470` |
| 4 | `_feeBps` | `200` (= 2%) |

**ABI‑encoded constructor arguments** (paste this exact string when asked — no `0x` prefix):

```
000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3000000000000000000000000b4cc7bfdd62b6faa6c24ff01c597b085dfadf470000000000000000000000000b4cc7bfdd62b6faa6c24ff01c597b085dfadf47000000000000000000000000000000000000000000000000000000000000000c8
```

*(Verified to byte‑match the on‑chain creation input.)*

---

## Steps in Remix (your chosen route)

1. **Solidity Compiler** tab → set **Compiler** to `0.8.34+commit.80d5c536`.
2. Open **Advanced Configurations** → make sure **Enable optimization is UNCHECKED**. Set **EVM Version** to `default`. Language = Solidity.
3. Open the **flattened** file `DustSweepPermit2RouterV2_flattened.sol` (NOT the version with `@openzeppelin` imports) and click **Compile**. It should compile with 0 errors.
4. **Contract Verification** tab → **Settings** → confirm your BaseScan API key is entered.
5. **Verify** tab:
   - Chain: **Base (8453)**
   - Contract address: `0x6d3C31E4a2b8e1Fe9De0d260D142183E82cbE1E3`
   - Contract: **DustSweepPermit2RouterV2**
   - Constructor arguments: paste the ABI‑encoded string above (if a field is shown).
6. Click **Verify**. Sourcify and Blockscout already show ✓ — you only need the **Etherscan** row to turn green.

Once verified, all the readable function names (`sweepWithPermit2`, `sweepWithAllowance`, `setFeeBps`, etc.) appear automatically on the **Read/Write Contract** tabs.

---

## Backup: verify on the BaseScan website (if Remix still fails)

1. Go to `https://basescan.org/address/0x6d3C31E4a2b8e1Fe9De0d260D142183E82cbE1E3#code` → **Verify & Publish**.
2. Compiler type: **Solidity (Single file)**.
3. Compiler version: `v0.8.34+commit.80d5c536`. License: MIT.
4. **Optimization: No.** EVM Version: `default`.
5. Paste the flattened source: use `packages/contracts/remix/DustSweepPermit2RouterV2_Remix.sol` (or the same `dustsweep-v2.sol`).
6. **Constructor Arguments ABI‑encoded:** paste the string above.
7. Submit.

---

## After verification — logo, name tag & website

This part needs you to **prove ownership** by signing a message from the owner wallet **`0xB4Cc7bFDd62b6FaA6c24ff01C597b085Dfadf470`** (the same wallet you deployed from).

1. Log in to BaseScan → **Verify Address Ownership** (basescan.org → your account → *Verified Addresses* / via the address page's **More** menu).
2. Enter the contract address and **sign the message** with the `0xB4Cc…` wallet. This links the contract to your account.
3. Once verified, submit an **address info / token update** request:
   - **Name Tag:** `DustSwap: Sweep Router`
   - **Website:** your live domain (e.g. `https://dustswap.xyz` or `https://dustswap.wtf`)
   - **Socials / project info:** add as desired.
   - **Logo:** upload your PNG (square, transparent background, ~256×256 works well).
4. BaseScan reviews and applies the changes (can take from hours to a few days).

**Heads‑up on the logo:** BaseScan shows logos natively in its **Token Tracker**, which only applies to ERC‑20 token contracts. This router is **not a token**, so the logo may not appear the same way a token logo does — but the verified‑owner badge, name tag, and website link will. Submitting the logo with the ownership‑verified request is still the correct path; BaseScan decides how it's displayed.

---

## A note on "rename function to `sweep`"

Your main swap function is **`sweepWithPermit2`** (plus `sweepWithAllowance`). Renaming it to just `sweep` would change the contract's bytecode, which means **redeploying to a new address** and updating your dApp — it can't be done as part of verification. Verification only makes the *existing* names human‑readable on BaseScan, which is almost certainly what you want here.

---

### Quick reference (copy/paste)

- Address: `0x6d3C31E4a2b8e1Fe9De0d260D142183E82cbE1E3`
- Compiler: `v0.8.34+commit.80d5c536` · Optimization: **No** · EVM: `default` · License: MIT
- Constructor args (no 0x):
  `000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3000000000000000000000000b4cc7bfdd62b6faa6c24ff01c597b085dfadf470000000000000000000000000b4cc7bfdd62b6faa6c24ff01c597b085dfadf47000000000000000000000000000000000000000000000000000000000000000c8`
