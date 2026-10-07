# Launch reward validation — 2026-10-07

Scope: the optional platform-token campaign. It is separate from MemeFun trading-fee and X-author payouts. No campaign was deployed, funded or activated during these checks.

## Results

| Check | Result |
| --- | --- |
| New campaign frontend tests | 55 passed: 17 UI, 12 hook, 21 attributed transaction, 5 live-market adapter |
| Complete frontend unit suite | 671 passed across 63 files; bounded workers, 119.66 seconds |
| New campaign backend unit tests | 42 passed |
| Complete backend unit suite | 309 passed |
| Real PostgreSQL integration | 7 passed against a fresh disposable database; database, container and volume removed |
| New campaign contract and deployment-helper tests | 26 passed, including 1,000 payout/reserve fuzz runs |
| Frontend production build | Passed: compilation, type validation and all 15 pages generated |
| Frontend/backend typecheck and scoped lint | Passed; campaign hook cleanup warning resolved |
| Diff whitespace check | Passed |

The Solidity run used stock Foundry 1.7.1, solc 0.8.26, Cancun, via-IR and optimizer 1,000 in an isolated test root containing exact copies of the new production contract, deployment helpers and test file. This avoids the unrelated B20-specific fork toolchain. It was a local simulated chain, with public deterministic test keys.

The first complete frontend runs exposed a repeated-empty-state render loop when preview mode supplied a fresh market adapter without campaign methods. It exhausted the test worker heap. The hook now keeps an already empty state object and skips polling entirely when no campaign API exists. A bounded fresh-preview regression and the previously stalled five creation-screen tests pass. The final complete suite passed with `NODE_OPTIONS=--max-old-space-size=6144` and `vitest run --maxWorkers 2 --no-file-parallelism`; the failed attempts are not counted as successful suites.

## Exercised behavior

- Off, unconfigured, invalid flags, invalid TTL, wrong-chain, wrong-signer, wrong-factory, wrong-token, wrong-decimals, unactivated and underfunded states fail closed.
- Exact raw amount formatting, allocation counts and one-reward-per-wallet disclosure. Inactive trade rule hidden; earlier wallets retain launch-only copy and eligibility after activation of the later rule.
- Finalized launch ordering by block/log position, strict activation boundary, repeated-launch deduplication, exactly slots 0 through 999, and rejection of the 1,001st wallet.
- Original launchers remain eligible after creator transfers. Multiple pair pools and discovery moderation do not change a wallet's slot.
- Completed-block checkpoint checks require both latest and durable safe history. Review of installed Ponder 0.17.12 confirmed checkpoint aliases and indexed table views are promoted atomically in production.
- Positive later-block regular trades qualify when required; first buys, module operations, zero amounts, unlaunched tokens and unfinalized trades do not.
- Authenticated session controls the ticket recipient. Forged recipient/slot/coin fields are ignored. Replica-safe PostgreSQL quotas are atomic; unauthorized and rate-limited requests do not sign tickets.
- EIP-712 binding of every field, chain and distributor; expiry/refreshed tickets; front-running and signature malleability; duplicate-wallet and duplicate-slot rejection.
- Fixed equal payout and full remaining reserve. Failed or taxed transfers roll back claim state; normal no-return ERC20 transfers work. Contract-wallet recipients can claim their own tickets.
- Wallet switching and late reads cannot restore an earlier wallet's eligibility. Duplicate clicks, cancelled and uncertain submissions do not trigger automatic resends.
- Preview adapters without campaign methods render no campaign UI and schedule no polling, including when the adapter object changes on each render. Returning from an active campaign to preview clears old reward data.
- EOA claims append the registered builder suffix once. Supported smart-wallet claims use mandatory wallet-side attribution; unsupported or ambiguous wallet results do not fall back to a second send.
- Future deployment defaults to simulation, uses only public constructor configuration, requires explicit opt-in for fresh broadcasts and preserves attributed CREATE constructor decoding and nonce behavior. Funding and activation stay separate.

## Deployment gates still pending

The platform token and selected token allocation do not exist in this campaign configuration yet. The live distributor's constructor tuple, deployment receipt, explorer verification, full reserve, activation receipt and a real authenticated claim must therefore be checked after those values are supplied. A browser test using real wallet hardware/provider prompts remains part of that activation check. These local tests do not establish mainnet payout completion.

See [setup and activation guide](LAUNCH-REWARDS.md). Back up the immutable dedicated signer before funding. Eligibility is attested by that signer; a compromised signer remains able to misassign the fixed reserve.
