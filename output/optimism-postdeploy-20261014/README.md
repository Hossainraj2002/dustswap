# Optimism post-deployment recheck, 2026-10-14

The deployed router passes the tested execution paths. **Optimism is not yet available in the
production app:** both the app's `/api/dustsweep/quote` proxy and the direct Railway API return
`400 CHAIN_NOT_ENABLED` for chain 10. Their reported enabled chains are
`8453,1,56,42161,4663`; the Base control request passes chain resolution and reaches body validation.
These checks supplied only a chain ID, without a wallet, tokens, amounts or a transaction.
See `production-gates.json` for the actual responses.

## Actual deployed contract

Router: `0x54C177426033d50686bA7D36B690d1a2d7E34625`.
The read-only dependency check passed at OP block **158200221**, including:

- Owner `0xF113b1dBd848F44684f8543CcDf63C90f9535F57`.
- Fee recipient `0xE09495e955794708D4bC28045C46891cAf643733`, default **200 bps**.
- Canonical Permit2/WETH, native six-decimal USDC, DEX factories and router getters.
- Unpaused state and all five target/self-spender pairs.

**Six actual-router fork tests passed**, with no failures or skips, at block **158200380**.
The tests use the existing deployed bytecode and configuration, real forked DEX liquidity and
local test-account signatures. They cover one four-token native-ETH sweep, canonical Permit2
witness/replay protection, atomic rollback, an individual failing leg with refund and healthy
settlement, and actual Kyber/LI.FI payloads built for this deployed address. Fees, recipient and
collector balance changes, zero final approvals and preserved router reserves are checked.
No replacement router, owner impersonation or configuration changes are used.

Detailed amounts and repeat commands: `../optimism-coverage/deployed-router-smoke-2026-10-14.md`.

## API and real liquidity

The API regression suite passes **34 tests**. Four live Hono quote/build cases also pass against
this deployed router, using actual public RPC/provider reads and a public pool's token balances:
WETH to USDC, USDC to WETH, a USDC+WETH native-ETH basket and its Permit2 metadata. Database access
alone is mocked, and the transfer probe is process-disabled; this is not a production database
or connected-wallet test. See `api-runtime-report.json` and `api-runtime-harness.cjs`.

Fresh market observations cover 195 official-list OP tokens: 132 have a price hint and 63 remain
unpriced. **51** have at least $1,000 of indexed liquidity; all **51/51** return positive canonical
Kyber routes at both approximately **$1** and **$0.01**, without provider errors. See
`liquid-token-quotes.json` and `liquid-dust-quotes.json`. This proves measured route availability,
not successful execution or fair pricing for every token. The 2026-10-13 cohort had 52 assets;
prices and indexed liquidity change over time.

The recheck fixes OP execution-gas costs below one cent being rounded to zero and suppressing
small-basket gas warnings. Base's existing gas literals and other chains' rounding are preserved.
This display model remains execution-gas-only: wallet estimates include OP L1/operator fees.

## Wallet and result corrections

**23 targeted frontend checks pass**: nine receipt/result checks, eight actual hook callback and
chain-parity checks, and six wallet-RPC checks. The recheck corrected:

- The displayed minimum now uses the actual build's one aggregate gross floor, then deducts
  its fee; it no longer promises the sum of every quoted leg's floors when a leg may be skipped.
  Exact wallet-side WETH unwrap is handled separately.
- Success amounts and fees come from matching router receipt events. Executed, skipped,
  refunded and failed-refund inputs are distinguished. Missing/malformed settlement evidence
  displays an unavailable amount instead of a quoted payout. Confirmed chunk results combine
  once, and legacy Base V1/V2 event formats remain supported.
- OKX fallback chunks use the effective routes and exclude newly build-dropped tokens from
  approval calls, while retaining their skip counts and healthy inputs.

These are local source changes awaiting the app release. The receipt parser checks the router,
user, recipient, output token and transaction. USD values still use the quote's price estimate;
the token amounts come from receipts. Full web type-check retains four pre-existing diagnostics
and the API retains 52; this recheck introduces no new type diagnostics.

## Base comparison and release state

Optimism uses the same shared scan/quote/build/wallet system and modern router sweep ABI. Its
tested mechanisms include exact approvals, Permit2, one aggregate settlement, failed-leg refunds,
output-floor rollback, native output and actual-output fees. Its venues are chain-specific:
Uniswap V3/V2, Velodrome V2, Kyber and LI.FI. It intentionally has a 10-input app cap and no Base
paymaster sponsorship. Atomic approvals+sweep still depend on live wallet capabilities; a fresh
EOA can need separate initial approvals.

Local API/web router configuration points at this verified deployment, but local gates remain
`8453,1,56`. Production activation needs the checked database migration, production provider/app
release and connected-wallet checks. Existing unrelated full-build diagnostics and shared rewards
receipt/idempotency limitations remain documented in `docs/dustsweep-optimism-10-plan.md`.

No real transaction was signed or broadcast during this recheck. No private environment key,
production database, application gate or service configuration was changed.
