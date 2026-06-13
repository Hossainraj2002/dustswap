# General FAQ

Quick answers to the most common DustSweep questions. Each answer links to the page with full detail.

## Basics

**What is DustSweep?**
A tool that converts many small token balances on Base into ETH, USDC, WETH, or USDT in one sweep. See [What is DustSweep?](what-is-dustsweep.md).

**Which network does it support?**
Base mainnet (chain ID 8453) only. See [Supported Network & Tokens](supported-network-and-tokens.md).

**Is it custodial?**
No. Tokens move wallet → contract → DEX → wallet inside one atomic transaction; the contract holds nothing between transactions. See [Non-Custodial Design & Approvals](non-custodial-design.md).

**What is the contract address?**
The active sweep router (DustSweep V3, `DustSwapSweepRouter`) on Base: `0x06e6BAa61A5Da1E4469FCa5dEa3EB68324255E20`. Verify it on [BaseScan](https://basescan.org/address/0x06e6BAa61A5Da1E4469FCa5dEa3EB68324255E20).

## Costs

**What does a sweep cost?**
A 2% protocol fee taken from the output (hard-capped at 3% on-chain) plus Base gas — typically a few cents. See [Fees](fees.md).

**Is there a fee on failed or refunded tokens?**
No. Fee applies only to realized output; skipped tokens are refunded in full.

## Limits & tokens

**How many tokens per sweep?**
Up to 50 (smart-contract limit).

**Why can't I sweep a certain token?**
No liquidity, no reliable price, value below $0.01, flagged as suspicious, or it is native ETH (wrap to WETH first). See [Why Some Tokens Can't Be Swept](why-some-tokens-cant-be-swept.md).

**Can I sweep WETH into native ETH?**
Not currently — that is an unwrap, not a swap. Sweep WETH to a stablecoin or unwrap it separately.

**What output tokens are available?**
ETH (default), USDC, WETH, USDT. See [Choosing an Output Token](choosing-an-output-token.md).

## Wallets & prompts

**How many confirmations will I see?**
Batching wallets (Coinbase/Base Account, OKX): usually one. Others: one gas-free signature + one transaction, plus one-time exact approvals for new tokens. See [Executing a Sweep](executing-a-sweep.md).

**What exactly am I signing?**
A Permit2 message listing your exact tokens and amounts, the sweep contract as sole spender, a one-time nonce, a 30-minute expiry, and the full sweep plan (including the fee) frozen in a witness hash. See [What You Sign and Why It's Safe](what-you-sign.md).

**Why does it say my address is "set up with another wallet"?**
Your account was upgraded (EIP-7702) by a different wallet; only that wallet can batch on it. Switch to it for one-click, or continue with Sign & Sweep. See [EIP-7702 Explained](eip-7702-explained.md).

**Does DustSweep ever ask for unlimited approvals?**
No. Exact amounts only, always. See [Non-Custodial Design & Approvals](non-custodial-design.md).

## During & after the sweep

**What happens if one token's swap fails?**
It is skipped and its full amount refunded to your wallet **in the same transaction**; the rest of the sweep completes. See [After the Sweep](after-the-sweep.md).

**Why did I receive slightly less than quoted?**
Market movement within your slippage tolerance plus the 2% fee. Per-token minimums you accepted are always enforced. See [Slippage & Price Impact](slippage-and-price-impact.md).

**My quote expired. What now?**
Quotes last 30 minutes. Refresh and sweep with the new quote.

**Do sweeps earn rewards?**
Yes — sweeps count toward DustSwap points and quests (first sweep, 10+ tokens, $100+ value, and more).

## Security

**Is the contract audited?**
An internal AI-assisted security review has been completed (0 critical, 0 high findings); a further audit pass is planned and the published audit file will be updated. To be confirmed before publication: final audit artifacts. See [Security Model](security-model.md).

**Can DustSweep drain my wallet?**
No mechanism for it exists: approvals are exact-amount and reset to zero, signatures are single-use and expiring, and only allowlisted DEXes can ever be called.

**What is the single most important safety habit?**
Verify you are on **app.dustswap.wtf** and read every wallet prompt against [What the Wallet Prompts Mean](wallet-prompts.md).

## Related pages

- [Quick Start: Your First Sweep](quick-start.md)
- [Security Model](security-model.md)
- [Supported Wallets Overview](supported-wallets.md)
