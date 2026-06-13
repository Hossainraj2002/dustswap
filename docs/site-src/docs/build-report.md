# GitBook Build Report

Local build of `docs/gitbook-final/` from existing DustSweep and Dustswap platform documentation, prior to GitBook import/publish.

## Pages created

69 markdown files total:

- **38 pages copied/normalized** from `docs/dustsweep-gitbook-content/` (23 files) and `docs/dustswap-gitbook-content/` (14 files), plus the full `docs/dustsweep-technical-specification.md` — renamed to lowercase kebab-case, internal links rewritten to the new folder structure, and screenshot placeholders converted to image markdown.
- **29 new stub pages** for sections requested in the SUMMARY structure that had no existing source content (Introduction, Swap & Bridge, Spin Rewards, On-Chain Quests, Quest Rewards, Referral Eligibility/Anti-Sybil, Weekly/All-Time Leaderboard, Ranking System, full Security section, Contract Addresses section, Resources). Stubs use only facts already present in `dustswap-platform-master-plan.md` / the technical spec, and are explicitly marked where information is "to be confirmed before publication."
- `README.md` (space landing page) and `SUMMARY.md` (sidebar), matching the requested structure exactly.

Two existing README index files were repurposed and trimmed of internal/editorial planning notes: `dustsweep-gitbook-content/README.md` → `dustsweep/README.md`, and `dustswap-gitbook-content/README.md` → `resources/platform-features-index.md`.

**Excluded from the GitBook build** (internal/editorial, not user docs): `dustsweep-publication-review.md`, `dustswap-platform-master-plan.md`, and the pre-existing dev/audit docs (`Codex_Prompt_DustSwapSweepRouter_V3.md`, `SweepV2_*`, `eip7702-delegation-aware-workflow.md`, `fix-prompt-delegation-aware-sweep.md`). Originals are untouched in `docs/`.

## Placeholder screenshots created

29 placeholder PNGs (1280×720, 16:9 desktop) in `gitbook-final/assets/screenshots/`, using the exact filenames referenced by the page markdown (DustSweep names follow `docs/dustsweep-screenshot-plan.md`'s naming convention; platform-side names follow the same convention with a `dustswap-` prefix since no plan existed for them). Each placeholder shows the brand name, the screenshot's filename, and "Placeholder screenshot — replace with real capture." Replacing a file in place (same filename) will update the page automatically — no link changes needed.

## Diagrams inserted

The 10 Mermaid diagrams from `docs/dustsweep-diagrams.md` were saved as individual `.mmd` files in `gitbook-final/assets/diagrams/` (`dustsweep-user-flow`, `token-discovery-flow`, `route-generation-flow`, `permit2-flow`, `eip5792-batch-flow`, `eip7702-compatibility-flow`, `router-execution-flow`, `security-model`, `refund-flow`, `transaction-lifecycle`). These same diagrams (or close equivalents) were already embedded inline as ```mermaid blocks in 14 of the copied pages (9 DustSweep, 5 platform) — they were carried over as-is per "do not rewrite unless formatting fixes required." The standalone `.mmd` files are available for reuse/export if GitBook needs them as separate assets.

## Broken links fixed

All internal markdown links in the 38 copied pages were rewritten from the old flat structure to the new nested `gitbook-final/` paths (e.g. `(leaderboards.md)` → `(../leaderboards/leaderboard-overview.md)`). Automated check found **zero missing internal links, zero missing images, zero missing SUMMARY.md targets** across all 69 files.

## Quality checks performed

- All 95 SUMMARY.md entries resolve to existing files.
- All image references resolve to files in `assets/screenshots/`.
- All internal `.md` links resolve.
- All 10 `.mmd` files plus all inline ```mermaid blocks start with a recognized diagram type (flowchart/stateDiagram/sequenceDiagram).
- No API keys, private keys, seed phrases, or personal email addresses found.
- No claims of completed *external* audits — `dustsweep/security-model.md` and `security/audit-status.md` describe only an internal AI-assisted review and explicitly flag external audit status as "to be confirmed."
- No unsupported-chain "live" claims — all network references are Base mainnet (8453); Bridge and other-network mentions are explicitly marked "not live" / "to be confirmed."
- `/swapown` (the experimental internal swap route) does not appear anywhere in `gitbook-final/`.

## Remaining TODOs / "to be confirmed before publication" items

Carried over verbatim from source pages — search `gitbook-final/` for "to be confirmed" / "TBC" / "TODO". Highlights:

- DustSweep: fee collector address conflict, final audit artifact, paymaster availability, hardware-wallet combinations, multi-chain plans, owner governance (multisig/timelock) status.
- Platform: Footprint Drop referral-commission eligibility, streak-recovery window duration, profile-completion reward amount, spin-ticket expiry policy, off-app swap PP eligibility.
- New stub pages: Weekly Leaderboard existence (see Open Items below), live swap fee %, Bridge launch details, contract verification status on BaseScan, admin/owner-key governance.

## Items requiring your manual confirmation

1. **Weekly Leaderboard** — `leaderboards/weekly-leaderboard.md` is a placeholder; please confirm whether a weekly-reset board exists separately from the all-time boards described in `leaderboard-overview.md`.
2. **Internal audit PDF** (`DustSwapSweepRouter_Internal_Audit_2026-06-13.pdf`, shared via Google Drive) — could not be fetched (requires Google sign-in). If it should inform `security/audit-status.md`, please share findings directly or grant access.
3. **All 29 placeholder screenshots** — replace with real captures using the same filenames in `gitbook-final/assets/screenshots/`.
4. Anything tagged "to be confirmed before publication" above, when you're ready to finalize.

Local build (Tasks 1–7) is complete and ready for GitBook import (Task 8 onward).
