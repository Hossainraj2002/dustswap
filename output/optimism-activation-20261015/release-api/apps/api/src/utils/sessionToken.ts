// Stateless, HMAC-signed session token issued after a successful SIWE sign-in.
// Used to authenticate read access to wallet-bound private data (profile
// settings, linked wallets, partner earnings) without prompting a signature on
// every request. The token binds a verified wallet address to an expiry; it is
// not a bearer of any privilege beyond "this caller proved ownership of <address>".

import { createHmac, timingSafeEqual } from "crypto";
import { getAddress } from "viem";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h, matches the SIWE verify window
const MIN_SECRET_LENGTH = 16;

export type SessionTokenPayload = {
  address: `0x${string}`;
  /** Expiry as epoch milliseconds. */
  exp: number;
};

/**
 * Resolve the HMAC secret. Prefers a dedicated SIWE_SESSION_SECRET but falls
 * back to the already-configured admin secrets so existing deployments keep
 * working before the dedicated var is set. Throws (fail-closed) if none exist.
 */
function getSecret(): string {
  const secret =
    process.env.SIWE_SESSION_SECRET ||
    process.env.PARTNER_ADMIN_TOKEN ||
    process.env.QUEST_ADMIN_TOKEN ||
    "";

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      "SIWE session secret is not configured. Set SIWE_SESSION_SECRET (min 16 chars)."
    );
  }

  return secret;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", getSecret()).update(encodedPayload).digest("base64url");
}

export function issueSessionToken(
  address: string,
  ttlMs: number = DEFAULT_TTL_MS
): { token: string; expiresAt: number } {
  const normalized = getAddress(address);
  const expiresAt = Date.now() + ttlMs;
  const payload: SessionTokenPayload = { address: normalized, exp: expiresAt };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload);

  return { token: `${encodedPayload}.${signature}`, expiresAt };
}

/**
 * Verify a token and return its payload, or null if missing/malformed/forged/expired.
 * Never throws — a missing secret or any tampering yields null (fail-closed).
 */
export function verifySessionToken(
  token: string | null | undefined
): SessionTokenPayload | null {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return null;
  }

  let expected: string;
  try {
    expected = sign(encodedPayload);
  } catch {
    return null;
  }

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as SessionTokenPayload;

    if (!payload.address || typeof payload.exp !== "number") {
      return null;
    }

    if (payload.exp <= Date.now()) {
      return null;
    }

    return { address: getAddress(payload.address), exp: payload.exp };
  } catch {
    return null;
  }
}
