// Wallet-auth helpers built on the SIWE session token. Used to gate read access
// to wallet-bound private data and to enforce object-level ownership (the caller
// may only read/modify data for the address they proved ownership of).

import type { Context, Next } from "hono";
import { getAddress } from "viem";
import { verifySessionToken } from "../utils/sessionToken";

function extractBearer(c: Context): string | null {
  const header = c.req.header("authorization") || c.req.header("Authorization");
  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Returns the authenticated wallet address from a valid bearer token, or null.
 * Does not reject — use for endpoints that stay public but reveal extra fields
 * to the owner.
 */
export function getAuthAddress(c: Context): string | null {
  const payload = verifySessionToken(extractBearer(c));
  return payload ? payload.address : null;
}

/** Case-insensitive, checksum-safe address equality. */
export function isSameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) {
    return false;
  }

  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** Hono middleware: 401 unless a valid bearer token is present. */
export async function requireWalletAuth(c: Context, next: Next) {
  if (!getAuthAddress(c)) {
    return c.json({ success: false, error: "Authentication required." }, 401);
  }

  await next();
}
