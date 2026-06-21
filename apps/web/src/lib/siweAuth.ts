import type { Address, Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { base } from "viem/chains";
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
  /** Bearer token sent on protected API reads. Optional for legacy sessions. */
  token?: string;
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

export function getStoredSiweToken(address?: string) {
  const session = getStoredSiweSession();
  if (!session?.token) {
    return null;
  }

  if (address && session.address.toLowerCase() !== address.toLowerCase()) {
    return null;
  }

  return session.token;
}

/**
 * fetch() that attaches the SIWE bearer token (when present) plus the existing
 * maintenance-bypass headers. Use for endpoints that require wallet auth.
 */
export function authedApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const token = getStoredSiweToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return publicApiFetch(input, { ...init, headers });
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
        token?: string;
        expiresAt?: string;
        error?: string;
      };

      if (!response.ok || !data.success || !data.address || !data.expiresAt) {
        throw new Error(data.error || "Failed to verify sign-in");
      }

      const result: StoredSiweSession = {
        address: data.address,
        token: data.token,
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

const ensureSessionInFlight = new Map<string, Promise<StoredSiweSession>>();

/**
 * Return a stored SIWE session with a bearer token for `address`, performing the
 * nonce → sign → verify flow once if none exists. Throws if the user rejects the
 * signature. Callers should treat a thrown error as "not signed in" and degrade
 * gracefully (the protected sections will simply stay empty).
 */
export async function ensureSiweSession(input: {
  address: Address;
  signMessage: (args: { message: string }) => Promise<Hex>;
  chainId?: number;
  statement?: string;
}): Promise<StoredSiweSession> {
  const existing = getStoredSiweSession();
  if (
    existing?.token &&
    existing.address.toLowerCase() === input.address.toLowerCase()
  ) {
    return existing;
  }

  const key = input.address.toLowerCase();
  const inflight = ensureSessionInFlight.get(key);
  if (inflight) {
    return inflight;
  }

  const request = (async () => {
    const { nonce } = await requestSiweNonce();
    const message = createSiweMessage({
      address: input.address,
      chainId: input.chainId ?? base.id,
      domain: typeof window !== "undefined" ? window.location.host : "localhost",
      issuedAt: new Date(),
      nonce,
      statement: input.statement || "Sign in to DustSwap to view your profile.",
      uri: typeof window !== "undefined" ? window.location.origin : "http://localhost",
      version: "1",
    });
    const signature = await input.signMessage({ message });
    const session = await verifySiweSession({
      address: input.address,
      message,
      signature,
    });
    saveStoredSiweSession(session);
    return session;
  })().finally(() => {
    ensureSessionInFlight.delete(key);
  });

  ensureSessionInFlight.set(key, request);
  return request;
}
