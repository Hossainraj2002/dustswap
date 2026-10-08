# MemeFun bug recheck — 2026-10-08

Rechecked release `673000f`, including launch-reward backend, contract and frontend integration, wallet cancellation, creation validation, mobile layout and live trade controls. Four reproducible defects were corrected. Unrelated local pair-icon edits were preserved.

## Confirmed fixes

1. **Quiet blocks could prevent reward eligibility from becoming ready.** Ponder 0.17.12's default multichain finalizer records the last pruned application event in `safe_checkpoint`; that value can lag behind fully processed, finalized blocks. Requiring it to cover the RPC finalized block therefore incorrectly kept a quiet campaign unavailable. The store now requires complete-block coverage from both `latest_checkpoint` and `finalized_checkpoint`, and exactly one checkpoint row for the expected chain. Review of installed Ponder code confirmed that finalized advancement and undo-prefix pruning share one database transaction in this configuration. Lagging finality, incomplete blocks, wrong chains and multichain tables still fail closed. Tests reproduced the old false rejection and verify restart protection.

2. **A rejected wallet sign-in could request a second signature.** Initial SIWE session acquisition happened inside the claim-ticket retry block. A SIWE verification 401 was consequently treated as an expired ticket session before a ticket request had occurred. Initial sign-in now happens outside that retry. Only the ticket endpoint's exact `sign_in_required` response can trigger one fresh session. Rejected signatures, cancelled sign-in, failed renewal, other 401 codes, ticket timeouts and transaction ambiguity do not automatically repeat a wallet request or send a transaction.

3. **Claim progress stayed at wallet confirmation after submission.** The claim card now forwards the existing transaction-stage callback and shows preparation, wallet confirmation and receipt waiting separately. The duplicate-submission lock remains active across wallet changes; refresh stays disabled while pending.

4. **Unavailable trade quotes displayed zero received, fee and price impact.** This was reproduced on the live mobile trade sheet while its pool loaded. The panel now shows a loading message or the actual quote error, and displays quote figures only when `quote.ok` is true. Valid quotes, protected minimums and transaction guards are unchanged. Both new display regressions failed before the fix and pass after it.

## Verification

| Check | Result |
| --- | --- |
| Full frontend unit suite | 684 passed across 63 files |
| Full backend unit suite | 314 passed across 22 files |
| Campaign frontend subset | 66 passed: 19 UI, 12 hook, 14 adapter, 21 transaction |
| Trade panel subset | 15 passed, including two new quote-display regressions |
| Campaign backend subset | 47 passed |
| Real PostgreSQL integration | 7 passed; disposable database, container and volume removed |
| Campaign contract/helpers | 26 passed, including 1,000 fuzz cases; local simulation |
| Typecheck, scoped lint and whitespace | Passed for changed application source/tests |
| Production build | Passed: lint/types, compilation and all 15 pages generated |

Independent read-only review found no additional actionable regression in these fixes. Public API health passed, campaign configuration remained disabled and six exact QA token addresses were absent from discovery. Ten user tokens were visible at recheck time, including a new user launch since the prior release. The build retains the existing transitive ox/Tempo dynamic-import warnings; it completed successfully.

Browser checks at desktop and 390-pixel mobile width exercised the wallet picker and cancellation, required image/name/ticker errors, invalid tweet-link rejection, Auto/custom slippage, invalid custom slippage, live quote refresh and buy-to-sell amount reset. No horizontal page overflow or console error was observed. The desktop wallet button retained a 164-by-34-pixel rectangle through modal cancellation. These checks did not authenticate a real wallet or send financial transactions.

## Remaining live gates

The new campaign remains disabled until its platform token, allocation, distributor, dedicated signer and funding are configured. A real authenticated claim and explorer verification must be checked after deployment/funding; local tests do not prove a mainnet payout.

Earlier platform-wide QA still leaves genuine X-author verification/claim, phone and smart-wallet provider prompts, and a real holder-reward epoch/proof/claim pending. The keeper remains in dry-run mode, so recurring module transactions and holder publications are not enabled by this release. Existing test journals explain those checks; this review does not mark them complete.

The campaign intentionally trusts its immutable signer to attest launch order and identity. One reward per wallet does not prevent one person from using multiple wallets. Choose the ordinary fixed-supply, admin-less MemeFun token for funding: an admin-controlled or upgradeable external token can later freeze or change transfer behavior. No zero-bug or external-audit guarantee is made.
