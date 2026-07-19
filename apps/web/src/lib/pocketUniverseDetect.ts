"use client";

/**
 * Pocket Universe (PU) detection.
 *
 * PU is a browser extension that injects a MAIN-world script at document_start,
 * wraps `window.ethereum` and core page globals, and — on DeFi swaps — replaces
 * the dApp's OpenOcean referrer with its own address to divert the fee (it adds a
 * default 0.8% fee routed to 0x147cf0…1a566). Because it injects beneath our app,
 * a calldata guard can't block it; the reliable answer is to DETECT it and refuse
 * to run the swap widget until the user disables it.
 *
 * Detection is passive and PU-SPECIFIC (no heuristics that other wallet extensions
 * would trip). We never dispatch PU's internal event channels — those are anti-
 * spoof tripwires PU watches. All signals below were taken from PU's actual
 * shipped extension (id gacgndbocaddlemdiaadajmlggabdeod) and each is unique to it:
 *
 *   1. Window marker — when PU's provider proxy wraps `postMessage` it stores the
 *      native reference on `window.__jumperExtNativePostMessage`. This is present
 *      on page load (works on localhost too), and NO ordinary wallet sets it, so
 *      it can't false-positive on MetaMask/Rabby/OKX/Zerion/Ambire/etc.
 *   2. DOM overlay — when PU screens a tx it mounts light-DOM elements with fixed
 *      ids (`security-scan-overlay`, `tx-guard-badge`, `defi-shield-review-panel`).
 *   3. On-chain hijack — the server's referrer-hijack signal (certain, folded in).
 *
 * Signal strings live in one CONFIG block so a future PU version bump is a
 * one-line change.
 */

export type PocketUniverseSignal = "window_marker" | "dom_overlay" | "onchain_hijack";

export type PocketUniverseDetection = {
  detected: boolean;
  signals: PocketUniverseSignal[];
};

// ── Tunable, PU-specific signal config (update here if PU renames its markers) ──
// Persistent globals PU installs. Each is unique to PU's inject script.
const PU_WINDOW_MARKERS = ["__jumperExtNativePostMessage"] as const;
// Fixed ids PU gives its transaction-screening overlay (light DOM, id-queryable).
const OVERLAY_SELECTORS = [
  "#security-scan-overlay",
  "#tx-guard-badge",
  "#defi-shield-review-panel",
  "#pocketOverlayBox",
] as const;

export function isPocketUniverseGateEnabled() {
  const raw = (process.env.NEXT_PUBLIC_PU_GATE || "on").trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

function windowMarkerPresent(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const scope = window as unknown as Record<string, unknown>;
  for (const marker of PU_WINDOW_MARKERS) {
    const value = scope[marker];
    // PU stores the native postMessage function here; require a function so a
    // stray same-named string/flag on some page can never trip the gate.
    if (typeof value === "function") {
      return true;
    }
  }
  return false;
}

function overlayPresent(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  for (const selector of OVERLAY_SELECTORS) {
    try {
      if (document.querySelector(selector)) {
        return true;
      }
    } catch {
      // Ignore malformed-selector engines; try the next one.
    }
  }
  return false;
}

/** One-shot passive scan. `onchainHijack` lets the caller fold in the server's
 *  on-chain referrer-hijack signal (certain, zero false positive). */
export function detectPocketUniverse(onchainHijack = false): PocketUniverseDetection {
  const signals: PocketUniverseSignal[] = [];

  if (onchainHijack) {
    signals.push("onchain_hijack");
  }
  if (windowMarkerPresent()) {
    signals.push("window_marker");
  }
  if (overlayPresent()) {
    signals.push("dom_overlay");
  }

  return { detected: signals.length > 0, signals };
}

/**
 * Watch the page for PU appearing (e.g. its overlay mounting mid-flow, or the
 * provider proxy initializing slightly after our first scan). Runs an initial
 * scan, then observes DOM mutations. Returns a cleanup function.
 */
export function observePocketUniverse(
  onDetected: (detection: PocketUniverseDetection) => void
): () => void {
  if (typeof window === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }

  let fired = false;
  const emit = (detection: PocketUniverseDetection) => {
    if (detection.detected && !fired) {
      fired = true;
      onDetected(detection);
    }
  };

  emit(detectPocketUniverse());

  const observer = new MutationObserver(() => {
    if (windowMarkerPresent() || overlayPresent()) {
      emit({ detected: true, signals: ["dom_overlay"] });
    }
  });

  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    return () => {};
  }

  return () => observer.disconnect();
}
