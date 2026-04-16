const DEFAULT_REFERRAL_BASE_URL = "https://app.dustswap.wtf";
const PENDING_REFERRAL_CODE_KEY = "dustswap.pendingReferralCode";
const REFERRAL_ATTEMPTED_SESSION_PREFIX = "dustswap:referral-attempted";
const REFERRAL_TERMINAL_SESSION_PREFIX = "dustswap:referral-terminal";

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

export function normalizeReferralCode(code: string) {
  return code.trim().toUpperCase();
}

export function getReferralBaseUrl() {
  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configuredAppUrl) {
    return trimTrailingSlashes(configuredAppUrl);
  }

  if (typeof window !== "undefined") {
    const hostname = window.location.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return trimTrailingSlashes(window.location.origin);
    }

    return trimTrailingSlashes(window.location.origin);
  }

  return trimTrailingSlashes(DEFAULT_REFERRAL_BASE_URL);
}

export function buildReferralLandingPath(code: string) {
  return `/?ref=${encodeURIComponent(normalizeReferralCode(code))}`;
}

export function buildReferralLink(code: string) {
  return `${getReferralBaseUrl()}${buildReferralLandingPath(code)}`;
}

export function storePendingReferralCode(code: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PENDING_REFERRAL_CODE_KEY, normalizeReferralCode(code));
}

export function getPendingReferralCode() {
  if (typeof window === "undefined") {
    return null;
  }

  const storedCode = window.localStorage.getItem(PENDING_REFERRAL_CODE_KEY);
  return storedCode ? normalizeReferralCode(storedCode) : null;
}

export function clearPendingReferralCode() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(PENDING_REFERRAL_CODE_KEY);
}

function getReferralSessionKey(prefix: string, address: string, code: string) {
  return `${prefix}:${address.toLowerCase()}:${normalizeReferralCode(code)}`;
}

function readReferralSessionFlag(prefix: string, address: string, code: string) {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    window.sessionStorage.getItem(getReferralSessionKey(prefix, address, code)) === "1"
  );
}

function writeReferralSessionFlag(prefix: string, address: string, code: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(getReferralSessionKey(prefix, address, code), "1");
}

function clearReferralSessionFlag(prefix: string, address: string, code: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(getReferralSessionKey(prefix, address, code));
}

export function hasReferralAttemptedSession(address: string, code: string) {
  return readReferralSessionFlag(REFERRAL_ATTEMPTED_SESSION_PREFIX, address, code);
}

export function markReferralAttemptedSession(address: string, code: string) {
  writeReferralSessionFlag(REFERRAL_ATTEMPTED_SESSION_PREFIX, address, code);
}

export function clearReferralAttemptedSession(address: string, code: string) {
  clearReferralSessionFlag(REFERRAL_ATTEMPTED_SESSION_PREFIX, address, code);
}

export function hasReferralTerminalSession(address: string, code: string) {
  return readReferralSessionFlag(REFERRAL_TERMINAL_SESSION_PREFIX, address, code);
}

export function markReferralTerminalSession(address: string, code: string) {
  writeReferralSessionFlag(REFERRAL_TERMINAL_SESSION_PREFIX, address, code);
}

export function clearReferralTerminalSession(address: string, code: string) {
  clearReferralSessionFlag(REFERRAL_TERMINAL_SESSION_PREFIX, address, code);
}

export function isTerminalReferralError(message?: string) {
  const normalized = message?.toLowerCase() ?? "";

  return (
    normalized.includes("already referred") ||
    normalized.includes("invalid referral code") ||
    normalized.includes("cannot self-refer")
  );
}

// ── Referral onboarding modal dismiss state ───────────────────────────────
// Completely separate from the pendingReferralCode link-based flow.
const REFERRAL_ONBOARDING_DISMISSED_PREFIX = "dustswap:referral-onboarding-dismissed";

function getReferralOnboardingDismissedKey(address: string) {
  return `${REFERRAL_ONBOARDING_DISMISSED_PREFIX}:${address.toLowerCase()}`;
}

export function isReferralOnboardingDismissed(address: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(getReferralOnboardingDismissedKey(address)) === "1";
}

export function setReferralOnboardingDismissed(address: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(getReferralOnboardingDismissedKey(address), "1");
}
