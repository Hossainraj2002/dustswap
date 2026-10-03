import { randomBytes } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type pg from "pg";
import { type PublicClient, getAddress, isAddress, isHex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { z } from "zod";

import { HttpError, RateLimiter, clientIp, enforce, hashIp } from "../http";
import { type Sessions, bearerToken } from "./session";

/**
 * Sign-In with Ethereum, as the DustSwap API does it (routes/auth.ts), with nonces in Postgres so
 * any replica can verify them. Signatures are checked with viem's verifySiweMessage, which handles
 * plain wallets and smart wallets (ERC-1271, and ERC-6492 for wallets not deployed yet).
 */
const NONCE_TTL_SEC = 5 * 60;

export interface AuthDeps {
  pool: Pick<pg.Pool, "query">;
  sessions: Sessions;
  client: PublicClient;
  chainId: number;
  /** Hosts allowed as the SIWE `domain` (from ALLOWED_ORIGINS). */
  domains: Set<string>;
  ipSalt: string;
}

export type AuthVariables = { wallet: `0x${string}` | null };

/** Sets `wallet` from a valid bearer token, or null; never rejects. */
export function optionalAuth(sessions: Sessions): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    c.set("wallet", sessions.verify(bearerToken(c.req.header("authorization")))?.address ?? null);
    await next();
  };
}

/** 401 unless signed in. */
export function requireAuth(sessions: Sessions): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const session = sessions.verify(bearerToken(c.req.header("authorization")));
    if (!session) throw new HttpError(401, "sign_in_required", "Sign in with your wallet first.");
    c.set("wallet", session.address);
    await next();
  };
}

const verifyBody = z.object({
  address: z.string().refine((value) => isAddress(value, { strict: false }), "address"),
  message: z.string().min(1).max(4_000),
  signature: z.string().refine((value) => isHex(value) && value.length >= 132 && value.length <= 20_000, "signature"),
});

export function authRoutes(deps: AuthDeps) {
  const app = new Hono();
  const limiter = new RateLimiter();

  app.post("/v1/auth/nonce", async (c) => {
    const ipHash = hashIp(clientIp(c), deps.ipSalt);
    enforce(limiter, `nonce:${ipHash}`, 10, 60_000, "Too many sign-in attempts.");
    const nonce = randomBytes(16).toString("hex");
    await deps.pool.query(`DELETE FROM auth_nonce WHERE expires_at < now()`);
    await deps.pool.query(`INSERT INTO auth_nonce (nonce, ip_hash, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`, [
      nonce,
      ipHash,
      NONCE_TTL_SEC,
    ]);
    return c.json({ nonce, expiresAt: new Date(Date.now() + NONCE_TTL_SEC * 1000).toISOString(), chainId: deps.chainId });
  });

  app.post("/v1/auth/verify", async (c) => {
    const ipHash = hashIp(clientIp(c), deps.ipSalt);
    enforce(limiter, `verify:${ipHash}`, 20, 60_000, "Too many sign-in attempts.");
    const parsed = verifyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Send address, message and signature.");
    const address = getAddress(parsed.data.address);
    const message = parseSiweMessage(parsed.data.message);

    if (!message.address || getAddress(message.address) !== address) throw new HttpError(401, "siwe_address_mismatch", "The message was signed for a different address.");
    if (!message.domain || !deps.domains.has(message.domain.toLowerCase())) throw new HttpError(401, "siwe_domain", "This sign-in message is not for memefun.");
    if (message.chainId !== deps.chainId) throw new HttpError(401, "siwe_chain", "Sign in on the network memefun runs on.");
    if (!message.nonce) throw new HttpError(401, "siwe_nonce", "The sign-in message has no nonce.");

    // Single use: the nonce is deleted by the request that verifies it, valid or not.
    const consumed = await deps.pool.query(`DELETE FROM auth_nonce WHERE nonce = $1 AND expires_at > now() RETURNING nonce`, [message.nonce]);
    if ((consumed.rowCount ?? 0) === 0) throw new HttpError(401, "siwe_nonce", "This sign-in request expired. Try again.");

    const valid = await deps.client
      .verifySiweMessage({ message: parsed.data.message, signature: parsed.data.signature as `0x${string}`, address, domain: message.domain, nonce: message.nonce })
      .catch(() => false);
    if (!valid) throw new HttpError(401, "siwe_signature", "The signature does not match this wallet.");

    const { token, expiresAt } = deps.sessions.issue(address);
    return c.json({ address, token, expiresAt: new Date(expiresAt).toISOString() });
  });

  return app;
}
