import {
  MAINTENANCE_BYPASS_HEADER,
  MAINTENANCE_BYPASS_SESSION_KEY,
} from "@/lib/maintenanceBypassToken";

const DEFAULT_PUBLIC_API_ORIGIN = "http://localhost:3001";

function normalizePublicApiOrigin(value?: string | null) {
  const normalized = value?.trim();
  const origin = normalized || DEFAULT_PUBLIC_API_ORIGIN;

  return origin.replace(/\/+$/, "").replace(/\/api(?:\/.*)?$/, "");
}

export function getPublicApiOrigin() {
  // In the browser, always use the current (same-origin) origin so API requests
  // go through the Next.js `/api` rewrite proxy (next.config.js) instead of
  // hitting the API host cross-origin. In-app browsers (X/Twitter, Telegram,
  // etc.) and some networks/ad-blockers block third-party requests, which
  // surfaced to users as "Failed to fetch" / 0 PP even though the account is
  // fine. Server-side (SSR / route handlers) keeps the absolute API origin
  // because relative URLs aren't valid there.
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return normalizePublicApiOrigin(process.env.NEXT_PUBLIC_API_URL);
}

export function buildPublicApiUrl(path: string) {
  const normalizedPath = path
    ? path.startsWith("/")
      ? path
      : `/${path}`
    : "";

  return `${getPublicApiOrigin()}${normalizedPath}`;
}

/** Headers for cross-origin API calls during maintenance bypass (browser only). */
export function getMaintenanceBypassHeaders(): HeadersInit {
  if (typeof window === "undefined") return {};
  try {
    const token = sessionStorage.getItem(MAINTENANCE_BYPASS_SESSION_KEY);
    if (!token) return {};
    return { [MAINTENANCE_BYPASS_HEADER]: token };
  } catch {
    return {};
  }
}

export function mergeMaintenanceBypassInit(init?: RequestInit): RequestInit {
  const extra = getMaintenanceBypassHeaders();
  const headers = new Headers(init?.headers);
  const bypass = extra as Record<string, string>;
  const key = MAINTENANCE_BYPASS_HEADER;
  if (bypass[key]) headers.set(key, bypass[key]);
  return { ...init, headers };
}

export function publicApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return fetch(input, mergeMaintenanceBypassInit(init));
}
