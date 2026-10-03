import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { isAddress } from "viem";

import type { Lower } from "../lib/indexer/addresses";

/** An error the client caused or should see, rendered as `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export function errorBody(error: HttpError) {
  return { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
}

export function parseAddress(value: string | undefined, label = "address"): Lower {
  const trimmed = (value ?? "").trim();
  if (!isAddress(trimmed, { strict: false })) throw new HttpError(400, "invalid_address", `The ${label} is not a valid address.`);
  return trimmed.toLowerCase() as Lower;
}

export function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "invalid_limit", "limit must be a positive whole number.");
  return Math.min(n, max);
}

/**
 * JSON with a strong ETag and a short shared cache. A request carrying the same ETag gets a 304,
 * so polling clients cost almost nothing between snapshot refreshes.
 */
export function cachedJson(c: Context, body: unknown, options: { maxAge: number; staleWhileRevalidate?: number; private?: boolean }) {
  const text = JSON.stringify(body);
  const etag = `"${createHash("sha1").update(text).digest("base64url")}"`;
  const scope = options.private ? "private" : "public";
  c.header("Cache-Control", `${scope}, max-age=${options.maxAge}, stale-while-revalidate=${options.staleWhileRevalidate ?? options.maxAge * 5}`);
  c.header("ETag", etag);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.body(text, 200, { "Content-Type": "application/json; charset=utf-8" });
}

/** The caller's IP: first X-Forwarded-For hop (the proxy in front of us sets it), else the socket. */
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const direct = c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip");
  if (direct) return direct;
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

/** IPs are never stored; a salted hash is enough to rate-limit and to spot abuse. */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 32);
}

/** Fixed-window counters per key, in memory: burst protection for one process. */
export class RateLimiter {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  consume(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    if (this.counters.size > 100_000) {
      for (const [k, v] of this.counters) if (v.resetAt <= now) this.counters.delete(k);
    }
    const entry = this.counters.get(key);
    if (!entry || entry.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }
    if (entry.count >= limit) return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    entry.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }
}

export function enforce(limiter: RateLimiter, key: string, limit: number, windowMs: number, message: string) {
  const result = limiter.consume(key, limit, windowMs);
  if (!result.allowed) throw new HttpError(429, "rate_limited", `${message} Try again in ${result.retryAfterSec} seconds.`);
}

/** Normalizes an origin list ("localhost:3100", "https://memefun.dustswap.wtf/") to origins. */
export function normalizeOrigins(list: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of list) {
    const value = /^https?:\/\//i.test(raw) ? raw : raw.startsWith("localhost") || raw.startsWith("127.0.0.1") ? `http://${raw}` : `https://${raw}`;
    try {
      out.add(new URL(value).origin);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

/**
 * Writes must come from our app. Ponder answers every CORS preflight with `*`, so the browser would
 * let any site call us; this rejects a cross-site write by its Origin header. Requests without an
 * Origin (curl, servers) carry no ambient credentials and are left to authentication.
 */
export function originGuard(allowed: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (origin && !allowed.has(origin)) throw new HttpError(403, "origin_not_allowed", "Requests from this site are not allowed.");
    }
    await next();
  };
}
