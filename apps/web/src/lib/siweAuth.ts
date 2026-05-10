import type { Address, Hex } from "viem";
import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";

const SIWE_SESSION_STORAGE_KEY = "dustswap:siwe-session";
const SIWE_VERIFY_RECENT_TTL_MS = 15_000;

let nonceRequestInFlight:
  | Promise<{
      nonce: string;
      expiresAt: string;
    }>
  | null = null;
const verifyRequestInFlight = new Map<string, Promise<StoredSiweSession>>();
const recentVerifiedSessions = new Map<
  string,
  {
    expiresAt: number;
    value: StoredSiweSession;
  }
>();

export type StoredSiweSession = {
  address: Address;
  expiresAt: string;
};

function parseStoredSession(raw: string | null) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as StoredSiweSession;
    if (!parsed.address || !parsed.expiresAt) {
      return null;
    }

    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function getStoredSiweSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const session = parseStoredSession(
    window.localStorage.getItem(SIWE_SESSION_STORAGE_KEY)
  );

  if (!session) {
    window.localStorage.removeItem(SIWE_SESSION_STORAGE_KEY);
  }

  return session;
}

export function hasStoredSiweSession(address?: string) {
  const session = getStoredSiweSession();
  if (!session) {
    return false;
  }

  if (!address) {
    return true;
  }

  const matches = session.address.toLowerCase() === address.toLowerCase();
  if (!matches && typeof window !== "undefined") {
    window.localStorage.removeItem(SIWE_SESSION_STORAGE_KEY);
  }

  return matches;
}

export function saveStoredSiweSession(session: StoredSiweSession) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(SIWE_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredSiweSession() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(SIWE_SESSION_STORAGE_KEY);
}

export async function requestSiweNonce() {
  if (nonceRequestInFlight) {
    return nonceRequestInFlight;
  }

  const request = publicApiFetch(buildPublicApiUrl("/api/auth/siwe/nonce"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  })
    .then(async (response) => {
      const data = (await response.json()) as {
        success?: boolean;
        nonce?: string;
        expiresAt?: string;
        error?: string;
      };

      if (!response.ok || !data.success || !data.nonce) {
        throw new Error(data.error || "Failed to prepare sign-in");
      }

      return {
        nonce: data.nonce,
        expiresAt:
          data.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
    })
    .finally(() => {
      if (nonceRequestInFlight === request) {
        nonceRequestInFlight = null;
      }
    });

  nonceRequestInFlight = request;
  return request;
}

export async function verifySiweSession(input: {
  address: Address;
  message: string;
  signature: Hex;
}) {
  const cacheKey = `${input.address.toLowerCase()}:${input.message}:${input.signature.toLowerCase()}`;
  const recent = recentVerifiedSessions.get(cacheKey);

  if (recent && recent.expiresAt > Date.now()) {
    return recent.value;
  }

  if (recent) {
    recentVerifiedSessions.delete(cacheKey);
  }

  const inflight = verifyRequestInFlight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const request = publicApiFetch(buildPublicApiUrl("/api/auth/siwe/verify"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  })
    .then(async (response) => {
      const data = (await response.json()) as {
        success?: boolean;
        address?: Address;
        expiresAt?: string;
        error?: string;
      };

      if (!response.ok || !data.success || !data.address || !data.expiresAt) {
        throw new Error(data.error || "Failed to verify sign-in");
      }

      const result = {
        address: data.address,
        expiresAt: data.expiresAt,
      };

      recentVerifiedSessions.set(cacheKey, {
        expiresAt: Date.now() + SIWE_VERIFY_RECENT_TTL_MS,
        value: result,
      });

      return result;
    })
    .finally(() => {
      verifyRequestInFlight.delete(cacheKey);
    });

  verifyRequestInFlight.set(cacheKey, request);
  return request;
}
