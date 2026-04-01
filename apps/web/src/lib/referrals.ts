const DEFAULT_REFERRAL_BASE_URL = "https://base.app/app/app.dustswap.wtf";
const PENDING_REFERRAL_CODE_KEY = "dustswap.pendingReferralCode";

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

export function normalizeReferralCode(code: string) {
  return code.trim().toUpperCase();
}

export function getReferralBaseUrl() {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_REFERRAL_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return trimTrailingSlashes(configuredBaseUrl);
  }

  if (typeof window !== "undefined") {
    const hostname = window.location.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return trimTrailingSlashes(window.location.origin);
    }
  }

  return DEFAULT_REFERRAL_BASE_URL;
}

export function buildReferralLink(code: string) {
  return `${getReferralBaseUrl()}/ref/${encodeURIComponent(normalizeReferralCode(code))}`;
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

export function isTerminalReferralError(message?: string) {
  const normalized = message?.toLowerCase() ?? "";

  return (
    normalized.includes("already referred") ||
    normalized.includes("invalid referral code") ||
    normalized.includes("cannot self-refer")
  );
}
