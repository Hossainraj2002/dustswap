import type { Context } from "hono";

// Resolve the real client IP, preferring trustworthy proxy-set headers over the
// spoofable FIRST X-Forwarded-For hop. Behind Cloudflare, `cf-connecting-ip` is
// authoritative and cannot be forged by the client, which makes per-IP rate
// limits actually effective (the old `xff.split(",")[0]` was attacker-spoofable).
export function getClientIp(c: Context): string {
  const trusted =
    c.req.header("cf-connecting-ip") ||
    c.req.header("true-client-ip") ||
    c.req.header("x-real-ip");
  if (trusted && trusted.trim()) {
    return trusted.trim();
  }

  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  return "unknown";
}

// IP for requests that arrive through our own Next dustsweep proxy, which forwards
// the real browser IP as `x-client-ip`. Falls back to the standard resolution for
// direct (non-proxied) calls. Returns null when no real IP can be determined, so
// the caller can FAIL OPEN (never block legit sweeps on an unknown IP).
export function getProxiedClientIp(c: Context): string | null {
  const forwarded = c.req.header("x-client-ip");
  if (forwarded && forwarded.trim()) {
    return forwarded.trim();
  }

  const resolved = getClientIp(c);
  return resolved === "unknown" ? null : resolved;
}
