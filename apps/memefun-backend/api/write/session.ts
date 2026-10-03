import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress } from "viem";

/**
 * Stateless, HMAC-signed session tokens issued after a successful sign-in (the same scheme as the
 * DustSwap API's utils/sessionToken.ts, copied, with no fallback secret). A token proves "this
 * caller signed in as <address>" until it expires, and nothing more.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

export interface SessionPayload {
  address: `0x${string}`;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export function createSessions(secret: string) {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SIWE_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const sign = (encoded: string) => createHmac("sha256", secret).update(encoded).digest("base64url");

  return {
    issue(address: string, now = Date.now()): { token: string; expiresAt: number } {
      const payload: SessionPayload = { address: getAddress(address), exp: now + SESSION_TTL_MS };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return { token: `${encoded}.${sign(encoded)}`, expiresAt: payload.exp };
    },

    /** The payload of a valid token, or null for anything missing, forged, malformed or expired. */
    verify(token: string | null | undefined, now = Date.now()): SessionPayload | null {
      if (!token) return null;
      const [encoded, signature, extra] = token.split(".");
      if (!encoded || !signature || extra !== undefined) return null;
      const expected = Buffer.from(sign(encoded));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
        if (typeof payload.exp !== "number" || payload.exp <= now || typeof payload.address !== "string") return null;
        return { address: getAddress(payload.address), exp: payload.exp };
      } catch {
        return null;
      }
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec((header ?? "").trim());
  return match?.[1] ?? null;
}
