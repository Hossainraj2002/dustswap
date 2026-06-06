# Claude Code Fix Prompt — Bug #2: OKX wallet connection (extension **and** app)

> Paste everything below the line into Claude Code, running inside the DustSwap repo. It is self-contained.

---

## Task

Fix OKX wallet connection in the DustSweep app so that **all three OKX entry points connect reliably and can complete a sweep**:

1. **OKX browser extension** (desktop) — currently works; **must not regress.**
2. **OKX mobile app via WalletConnect** — user opens `app.dustswap.wtf` in a normal mobile browser (Chrome/Safari), picks OKX, and it should connect through the OKX app. Currently fails ("Waiting for OKX Wallet… Please try connecting again", or first-load blur/stuck screen).
3. **OKX in-app browser** (the dApp browser inside the OKX mobile app) — should auto-detect the injected OKX provider and connect.

"Works" means: wallet connects, the address shows as connected in the UI **and** the Sweep panel does not say "Connect a wallet first" — i.e. the wagmi `walletClient` is actually available so a sweep can run.

This is a **connection-layer bug only**. Do **not** change sweep execution, approvals, Permit2, or any non-wallet surface (quests, spin, swap, leaderboard, footprint, referrals).

## Repo orientation

- Monorepo (pnpm). The web app is in `apps/web`. All paths below are under `apps/web/src`.
- Stack: Next.js (App Router) + **Privy** (`@privy-io/react-auth` and `@privy-io/wagmi`) + **wagmi/viem** + **WalletConnect** (via Privy). Chain is **Base (8453)**.
- Privy owns the wagmi connectors; there are **no** hand-written wagmi connectors in `config/web3.ts` (it only configures chains + RPC transports).

### Files you will touch / read first
- `app/providers.tsx` — `PrivyProvider` config, `walletConnectCloudProjectId`, external wallet config (Coinbase has explicit config; **OKX does not**), wraps app in `@privy-io/wagmi` `WagmiProvider` + `WalletConnectionProvider`.
- `hooks/useWalletConnection.tsx` — `PRIVY_WALLET_LIST`, `DUST_SWEEP_PRIVY_WALLET_LIST`, `getRuntimeWalletList()` (reorders/filters wallets by runtime), and the `onSuccess` handler that calls Privy `setActiveWallet`. **This is the most important file.**
- `lib/ethereumProviders.ts` — injected-provider detection (`isOkxAppBrowser` via `OKApp` UA, `hasInjectedOkxWallet`, `isOkxEthereumProvider`, walks `window.okxwallet` / `window.ethereum.providers[]`).
- `components/wallet/WalletConnectButton.tsx` — connect button; reads `useAccount()` (wagmi) for connected state, calls `openWalletModal()`.
- `hooks/useDustSweep.ts` — the sweep executor; **line ~1451 throws `"Connect a wallet first"`** when `address`/`walletClient` (wagmi) are missing.
- `app/dustsweep/page.tsx` — gates the page on `useAccount().isConnected` (wagmi).
- `components/WalletInterceptor.tsx` — globally monkey-patches `window.ethereum.request` to inject fallback gas on approve/sweep calls. **Be careful: do not let any change here break the OKX injected provider.**
- `.env`, `.env.local` (in `apps/web`) — WalletConnect project id env vars (see Root Cause B).

## Root causes (confirmed by code review) and required fixes

### A — First-load "blur screen stuck"
On first visit the page shows the logo blurred behind a white sheet and is unresponsive until you tap.

**Likely cause:** the connect modal / its `backdrop-blur` overlay mounts before Privy is `ready` (SSR/hydration + `reconnectOnMount`), and the empty overlay captures pointer events.

**Fix:**
- Gate any connect UI / overlay on Privy readiness. Use Privy's `ready` (from `usePrivy()`) and wagmi mount state; do not render an interactive backdrop before the modal has content.
- Ensure the overlay is `pointer-events: none` until the modal is actually open with content, and lives in a focus-trapped portal.
- **Acceptance:** cold load on mobile is interactive immediately; no stuck blur; tapping "Connect wallet" opens the Privy modal first try.

### B — WalletConnect handshake fails ("Waiting for OKX Wallet")
The OKX **app** connects over WalletConnect; this handshake is flaky/failing.

**Investigate and fix, in order:**
1. **WalletConnect project id is ambiguous and possibly a placeholder.** `app/providers.tsx` resolves it as:
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || NEXT_PUBLIC_WC_PROJECT_ID || "6f242331a85fc3af5428da560ed78900"`.
   - `apps/web/.env.local` sets `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to the **same value as the hardcoded fallback** (`6f2423…`), while `apps/web/.env` sets a **different** `NEXT_PUBLIC_WC_PROJECT_ID` (`e3ac88…`) that gets shadowed.
   - **Action:** consolidate to a **single** env var (`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`), remove the others, and **verify it is a real, active Reown/WalletConnect Cloud project owned by the team with `app.dustswap.wtf` (and `base.app` if used) added to the project's Allowed Domains / verified domains.** A placeholder or domain-mismatched id causes exactly this "waiting / try again" relay failure. Log the resolved id length at startup (not the value) to confirm which one is live.
2. **OKX has no explicit Privy connector config**, unlike Coinbase (`externalWallets.coinbaseWallet` in `providers.tsx`). Check the installed Privy version's support for an explicit OKX/`okx_wallet` external connector or `walletConnect` options and add equivalent config so OKX gets first-class deeplink handling rather than generic WC.
3. **Mobile runtime wallet list** (`getRuntimeWalletList` in `useWalletConnection.tsx`): in a **plain mobile browser** (no OKX runtime), `detected_ethereum_wallets` is empty, so OKX must be reachable via the `okx_wallet` entry (WalletConnect/deeplink). Confirm `okx_wallet` is retained (not filtered out) in that branch. Only inside the OKX in-app browser (`isOkxAppBrowser()`) should it collapse to `detected_ethereum_wallets`.
- **Acceptance:** from Chrome/Safari on mobile, selecting OKX deeplinks into the OKX app, approval there returns to the dApp, and the address shows connected.

### C — Privy↔wagmi desync: "connected" but Sweep says "Connect a wallet first" (HIGHEST PRIORITY)
User reports OKX sometimes auto-connects, but going to sweep shows "Connect a wallet first."

**Confirmed cause:** the Sweep executor (`useDustSweep.ts` ~line 1451) and `app/dustsweep/page.tsx` both read **wagmi** state (`useAccount()` / `useWalletClient()`). OKX connects through **Privy**. If Privy reports a connected wallet but the connector is not promoted into the wagmi config, `useWalletClient()` is `null` → the sweep gate fails even though the UI elsewhere looks connected. In `useWalletConnection.tsx`, `useConnectWallet({ onSuccess })` calls `useSetActiveWallet().setActiveWallet(connectedWallet)`, but this is not guaranteed to complete (or to run for the OKX connector) before the user proceeds.

**Fix:**
- In `useWalletConnection.tsx`, make wagmi activation **deterministic**: in `onSuccess`, `await setActiveWallet(...)` and verify the wagmi connection (e.g., poll `getAccount`/`useAccount` or wagmi config state) before treating the wallet as connected. Handle the OKX connector explicitly (its `connectedWallet.connectorType` / `walletClientType`).
- Add a **reconciliation effect**: if Privy reports a connected wallet but wagmi `walletClient` is still `null` after a short delay, re-call `setActiveWallet` (or surface a single "Reconnect" affordance) instead of silently leaving a dead state.
- Make the **single source of truth for "connected" be wagmi** everywhere user-facing (`WalletConnectButton` already uses `useAccount` — good). Ensure the sweep gate and the page gate never disagree with what the connect button shows.
- **Acceptance:** after OKX connects (app or extension), `useWalletClient()` is non-null within ~1s and the Sweep panel is enabled; no "Connect a wallet first" while the header shows a connected address.

## Guardrails (do not break anything)

- **Regression-protect what works:** OKX **extension** and **Coinbase Wallet** must still connect and sweep before and after every change. Test these explicitly.
- Stay inside the connection layer (`providers.tsx`, `useWalletConnection.tsx`, `ethereumProviders.ts`, `WalletConnectButton.tsx`, and minimal reconciliation in the sweep gate). **Do not** modify sweep execution, approvals, Permit2, contracts, or the `WalletInterceptor` gas logic.
- Do not remove existing wallets from the Privy lists; only fix ordering/activation.
- Put any risky behavioral change behind an env flag where practical, defaulting to current behavior until verified.
- Keep changes minimal and well-commented; explain *why* (cite the desync/WC-id causes) so future readers don't revert them.

## Investigation steps to run BEFORE editing (report findings, don't guess)

1. Log and confirm **which** WalletConnect project id is resolved at runtime in `apps/web` (compare `.env` vs `.env.local`), and whether that project exists in Reown Cloud with the correct allowed domains.
2. Reproduce C: connect OKX, then log `useAccount()`, `useWalletClient()`, and Privy `useActiveWallet()` side by side to confirm the desync and timing.
3. Check the installed `@privy-io/react-auth` and `@privy-io/wagmi` versions and their current docs for explicit OKX connector / `walletConnect` config support.
4. Confirm `getRuntimeWalletList()` output for: desktop, plain mobile browser, OKX in-app browser (UA `OKApp`), OKX extension present.

## Verification matrix (must all pass)

| Scenario | Connect | `walletClient` non-null | Sweep panel enabled | No regression |
|---|---|---|---|---|
| OKX extension (desktop) | ✅ | ✅ | ✅ | required |
| OKX app via WalletConnect (mobile Chrome/Safari) | ✅ | ✅ | ✅ | new fix |
| OKX in-app browser (OKApp UA) | ✅ | ✅ | ✅ | new fix |
| Coinbase Wallet | ✅ | ✅ | ✅ | required |
| MetaMask (extension) | ✅ | ✅ | ✅ | required |

For each: connect → confirm header shows address → open Sweep → confirm it does **not** say "Connect a wallet first" → (where possible) run a 1-token sweep on Base to confirm `walletClient` truly works. Run `pnpm typecheck`/`pnpm lint`/`pnpm build` in `apps/web` and confirm clean.

## Out of scope (do not touch in this task)

- TokenPocket gas-estimation bug, MetaMask batch bug, Permit2 migration, contract changes, the wallet capability/allowlist gate redesign. Those are tracked separately.

## Deliverable

A focused diff limited to the connection layer, a short summary of the root cause you confirmed for B and C, the consolidated WalletConnect env setup, and the verification-matrix results.
