# DustSwap

**A Base consumer app that turns everyday onchain activity into one progress account.**

Swap, clear leftover dust into USDC, check in daily, finish quests, invite friends, and climb one shared leaderboard. Base's own app dashboard has ranked DustSwap in the top 3 apps on Base, and in June 2026 it was ranked #1 out of more than 17,000 Builder Code apps by daily transacting addresses.

| | |
| --- | --- |
| App | https://app.dustswap.wtf |
| Inside Base App | https://base.app/app/app.dustswap.wtf |
| Docs | [`docs/docs`](docs/docs) in this repo |
| Rank on Base | https://dashboard.base.org/share/c/app.dustswap.wtf |
| Builder Code | `bc_tpolfjho`, tracked at https://dune.com/base_ds/base-builder-codes |
| X | https://x.com/DustswapOnBase and https://x.com/akbarX402 |

## What DustSwap is

Most reward apps ask you to do something artificial to earn points. DustSwap adds progression around activity people already do on Base, so the app has a reason to be open every day rather than only during one campaign.

The public surfaces are Footprint Drop, Profile, Dust Sweep, Swap, Quests, Spin and Leaderboard. Every action feeds one account: PP, rank, streak, referral progress and volume all live in the same place.

## DustSweep

DustSweep is the part of the product we built from scratch, and it is the reason the app has its own contracts on Base.

A normal wallet ends up holding dozens of small token balances. Selling them one by one costs more in gas and approvals than the tokens are worth, so the dust sits there forever. DustSweep sells all of it in a single transaction and returns one token, normally USDC or ETH.

### How a sweep works

**Find.** Every token balance the wallet holds is read directly from the chain. The user never pastes a token address.

**Price.** Dust is the hardest thing in crypto to price, because pools are thin and many of these tokens are worthless or hostile. Real liquidity behind each token is checked rather than trusting a price feed, and tokens that cannot be sold are marked instead of silently failing later.

**Route.** Every token is quoted across direct pools and multiple aggregators. That is roughly 35 probe calls per token, packed into single Multicall3 reads so the whole scan stays fast and cheap.

**Send.** The router pulls the selected tokens, sells each one along its own best route, takes a 2% protocol fee on the output, and returns one clean balance. Anything that cannot be sold is left untouched in the wallet.

### Wallet compatibility

Wallets on Base no longer sign the same way, and getting this wrong means a failed transaction and a user who assumes the app is broken. DustSweep resolves the account before asking for anything.

**EIP-7702.** A delegated EOA stores a designator, `0xef0100` followed by the delegate address. Reading the code at the user's address on Base tells us whether the account is delegated and to which implementation. There is no public registry of delegate contracts, so this repo maintains its own, covering the major wallet brands as well as infrastructure providers such as Biconomy, ZeroDev, Gelato and Pimlico. See [`apps/web/src/lib/eip7702.ts`](apps/web/src/lib/eip7702.ts).

**EIP-5792.** The connected wallet is asked whether it can execute a batch atomically. If it can, approvals and the sweep are sent together as one `wallet_sendCalls` batch and the user confirms once.

**The registry never gates anything.** The wallet's own reported capability decides the execution path; the registry only decides what the route is called on screen. An unknown delegate degrades to the safe path, never to a block, and is logged so the registry grows.

**Delegated to a different wallet.** Only one wallet can manage a smart account at a time, so an address set up in one wallet cannot batch through another. Rather than failing, the app names the wallet that owns the account, offers a switch for one click, and offers a signature path to continue in place.

### What the user signs

The fallback path uses Permit2 with a witness that binds the fee and the recipient into the signature itself, so the user signs the exact fee and the exact destination and neither can be changed afterwards. DustSwap never holds user funds and never writes a delegation on a user's behalf.

## Contracts on Base

| Contract | Address |
| --- | --- |
| DustSweep Router V3 | `0x06e6BAa61A5Da1E4469FCa5dEa3EB68324255E20` |
| DustSweep Router V2 | `0x6d3C31E4a2b8e1Fe9De0d260D142183E82cbE1E3` |
| Spin and rewards | `0xCf10Edbc886C60086e49061c807a14E7009F9A22` |

All are verified on BaseScan. The routers are written in house rather than forked. DustSweep also runs on Ethereum, BNB Chain and Arbitrum so dust stranded on those chains can be cleared, but Base carries effectively all of the volume and is the only chain with the full app.

## Security

Written audit reports are public in [`packages/contracts/audit`](packages/contracts/audit). Raw static analysis output is deliberately kept out of this repo, because publishing unfiltered scanner findings for a live router hands attackers a prepared map. Deployment and verification records live in [`packages/contracts/remix`](packages/contracts/remix) and [`packages/contracts/verification`](packages/contracts/verification).

## Repo layout

| Path | What it is |
| --- | --- |
| `apps/web` | The app at app.dustswap.wtf. Next.js, wagmi and viem. |
| `apps/api` | Hono API: points engine, quests, referrals, token discovery, sweep routing and campaign verification. |
| `apps/site` | The public marketing site. |
| `packages/contracts` | Foundry workspace for the routers, plus audits and deployment records. |
| `docs` | Mintlify source for the public documentation. |

## Trust and safety

Only use the official links at the top of this file. Before connecting a wallet, check the domain, and read every transaction and signature prompt. Pay attention to the network you are on, which tokens an approval covers, and what a signature actually authorises. Campaign mechanics change, so the live app and the official X accounts are the source of truth.
