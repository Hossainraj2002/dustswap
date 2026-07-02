---
title: "Fees"
---

# Fees

DustSweep charges a single protocol fee of 2%, taken from the swap output — plus normal Base network gas. There are no deposit fees, no subscription, and no fee on failed or refunded tokens.

## The protocol fee

| | |
|---|---|
| **Current rate** | **2%** (200 basis points) of the realized output |
| **Hard cap** | **3%** — enforced by the smart contract; the fee can never exceed this, by anyone |
| **Charged on** | The actual output produced by your sweep, at the moment of settlement |
| **Not charged on** | Inputs, failed/skipped tokens (their full amount is refunded), or anything outside the sweep |

How it works on-chain: after all swaps complete, the contract measures the total output it actually received, takes `output × fee`, sends that to the fee collector, and transfers the remainder to you — all in the same transaction. The fee is visible in the quote before you approve anything.

## The fee is part of what you sign

On the signature-based flow ([Sign & Sweep](sign-and-sweep.md)), the **exact fee percentage is embedded in the message you sign**. If the fee were changed after you signed, your signature would become invalid and the transaction would fail — the fee you see is cryptographically the fee you pay.

## Gas

Gas is paid to the Base network, not to DustSweep. Sweeps are heavily batched, so even a 30-token sweep typically costs only a few cents on Base. The quote panel shows an estimate.

Some smart wallets (e.g. Coinbase Smart Wallet) may have gas sponsored via a paymaster when available — in that case you may see no gas charge at all. Availability depends on configuration.

## Example

Sweeping dust worth ~$20 into USDC:

| | |
|---|---|
| Gross output | $20.00 |
| Protocol fee (2%) | −$0.40 |
| **You receive** | **≈ $19.60 minus gas (typically a few cents)** |

> **User Safety Note**
> The quote always shows the fee before you confirm. If any interface claiming to be DustSweep shows a fee above 3%, it is not the real contract — the cap is enforced on-chain.

## FAQ

**Is there a fee if my sweep fails?**
No output, no fee. Reverted transactions still cost gas (a network property, not a DustSweep charge); tokens skipped inside a successful sweep are refunded in full.

**Can the fee change?**
The rate is adjustable by the contract owner but can never exceed the 3% on-chain cap. The rate shown in your quote — and signed in the Permit2 flow — is the rate applied to your sweep.

**Where does the fee go?**
To the protocol fee collector contract.

## Related pages

- [Understanding Your Quote](understanding-your-quote.md)
- [What You Sign and Why It's Safe](what-you-sign.md)
- [Security Model](security-model.md)
