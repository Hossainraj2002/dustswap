import type { MiddlewareHandler } from "hono";
import { compress } from "hono/compress";

const jsonContentType = /^application\/json(?:\s*;|\s*$)/i;
const variesOnEncoding = /(?:^|,)\s*accept-encoding\s*(?:,|$)/i;
const gzip = compress({ encoding: "gzip", threshold: 1024, contentTypeFilter: jsonContentType });

/**
 * Compress the large anonymous catalog before bytes leave the API container. Restrict this
 * to the exact public list: streams, wallet/auth data, writes and media retain their behavior.
 * Hono negotiates gzip, merges Vary, weakens ETags and skips existing encodings/no-transform.
 * https://hono.dev/docs/middleware/builtin/compress
 */
export function publicCatalogCompression(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" || c.req.path !== "/v1/coins"
      || ["authorization", "cookie", "x-admin-token", "range"].some(name => c.req.header(name)?.trim())) return next();

    await next();
    const control = c.res.headers.get("Cache-Control")?.toLowerCase().split(",").map(value => value.trim()) ?? [];
    if (!control.includes("public") || control.some(value => /^(?:private|no-store|no-cache)(?:=|$)/.test(value))
      || c.res.headers.has("Set-Cookie")) return;

    if (c.res.status === 304) {
      // A conditional response has no JSON body/content type to compress, but must retain
      // the same representation-selection metadata as its catalog 200 response.
      const contentType = c.res.headers.get("Content-Type");
      if (control.includes("no-transform") || c.res.headers.has("Content-Encoding") || c.res.headers.has("Transfer-Encoding")
        || contentType && !jsonContentType.test(contentType)) return;
      const vary = c.res.headers.get("Vary");
      if (vary !== "*" && !(vary && variesOnEncoding.test(vary))) c.header("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
      return;
    }
    if (c.res.status !== 200 || !jsonContentType.test(c.res.headers.get("Content-Type") ?? "")) return;

    // Response eligibility is known only after the handler. The built-in middleware runs
    // against that existing response; its no-op next never invokes the handler twice.
    await gzip(c, async () => undefined);
  };
}
