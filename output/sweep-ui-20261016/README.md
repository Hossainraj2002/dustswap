# DustSweep network controls and popup layout — 2026-10-16

Implemented locally; no Git push or Cloudflare deployment was performed.

- The token picker's network controls are 44×44 squares with local network logos,
  active state, accessible names and no visible network words inside the buttons.
  The row scrolls on narrow phones and keeps the active network in view.
- The widget header has a square network selector immediately before the wallet.
  Its menu has one logo/name row per enabled chain. It uses the same chain state
  and execution/switching guard as the token picker. Keyboard arrows, Home/End,
  Enter, Escape, Tab and outside clicks are supported.
- Token network badges use the actual local network images, with readable sizing.
- Token selection, Settings, guide, success and campaign popups share a body
  portal and centering stage. At desktop widths the stage excludes the sidebar;
  at phone widths it covers the content width. The full backdrop blocks the nav.
  A shared modal stack preserves layer priority, focus, Escape behavior and the
  body scroll lock when completion appears while Settings is open.

The sidebar width is shared between AppShell and the popup stage through
`--ds-desktop-sidebar-width`. AppShell's content flex item can shrink on narrow
screens, preventing the header/menu from being clipped.

## Browser verification

Checked the real local `/dustsweep` page without a connected wallet or transactions:

- Desktop 1280×720: widget/content center X = 758; guide center X = 758.
- Selected Optimism using the header menu's End/Enter keyboard controls. The
  header, output badge and token picker all reflected Optimism.
- Every token-picker network button measured 44×44 and had empty visible text.
- At 320×740 the menu fit the available content width (left 89.6, right 297.6,
  available width about 310). Settings and content centers both measured X154.8.
- At 375×812 all six logo buttons fit in one row. On narrower widths the row
  scrolls without widening the page.
- A temporary local QA fixture opened Settings at layer95 and completion at80.
  Settings kept focus; one Escape closed only Settings and focused completion;
  the second Escape restored the original button and original body overflow.
  See `modal-stack-check.json`. The temporary route was removed after the check.

Screenshots: `desktop-guide.jpg`, `desktop-network-menu.jpg`,
`desktop-token-picker.jpg`, `mobile-network-menu.jpg`, `mobile-token-picker.jpg`.
The preview enabled all six supported networks only in its process environment;
production/local environment files were not changed by this UI task.

## Validation

Fresh TypeScript check passed with zero errors. The full Next.js production build
passed (exit0), including lint/type validation, all32staticpages, optimization and
build traces. Only nonblocking dependency/lint warnings remain. The temporary QA
route is absent from the final build. Existing local preview API calls to port3001
failed because no local API server was started; visual checks did not require
wallet discovery, quotes, signing or backend changes.

## Additional source publication paths

Alongside the original Optimism web changes, include:

```text
apps/web/src/app/globals.css
apps/web/src/components/AppShell.tsx
apps/web/src/components/sweep/SlippageSettings.tsx
apps/web/src/components/sweep/SweepGuideModal.tsx
apps/web/src/components/sweep/SweepCampaignModal.tsx
apps/web/src/components/sweep/SweepModal.tsx
apps/web/src/components/sweep/SweepNetworkSelect.tsx
apps/web/src/components/sweep/SweepNetworkIcon.tsx
apps/web/public/dex/base.png
```

This task also updates the already-modified dustsweep page, TokenSelectModal,
TokenLogo and SweepSuccessModal. Keep the prior chain/runtime/receipt changes.
