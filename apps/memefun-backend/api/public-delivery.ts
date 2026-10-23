import type { MiddlewareHandler } from "hono";
import { type PublicDelivery, publicDeliveryRedirectFor } from "../lib/public-delivery-policy.mjs";

export { publicDeliveryConfig } from "../lib/public-delivery-policy.mjs";
export type { PublicDelivery } from "../lib/public-delivery-policy.mjs";

/** Avoid old app sessions downloading entire catalogs/media directly from the Railway origin. */
export function publicDeliveryRedirect(config: PublicDelivery | undefined): MiddlewareHandler {
  return async (c, next) => {
    const redirect = publicDeliveryRedirectFor(config, {
      method: c.req.method,
      url: c.req.url,
      headers: {
        authorization: c.req.header("authorization"), cookie: c.req.header("cookie"),
        "x-admin-token": c.req.header("x-admin-token"), range: c.req.header("range"),
      },
    });
    if (!redirect) return next();
    // Temporary and short-lived for a straightforward rollback; metadata itself stays canonical.
    for (const [name, value] of Object.entries(redirect.headers)) c.header(name, value);
    return c.redirect(redirect.location, redirect.status);
  };
}
