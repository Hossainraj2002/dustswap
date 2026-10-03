import type { Hono } from "hono";

import { isCid } from "../lib/cid";
import type { MediaStore } from "../lib/media/store";
import { HttpError } from "./http";

/**
 * Serves stored media by CID. Content-addressed, so every response is immutable. Locked down:
 * served bytes can never run script or be sniffed into another type, and other sites may embed them.
 * (In production R2 serves these from the media domain; this route also covers local development.)
 */
export function mountMedia(app: Hono, media: MediaStore) {
  app.get("/media/:cid", async (c) => {
    const cid = c.req.param("cid");
    if (!isCid(cid)) throw new HttpError(400, "invalid_cid", "That is not a content identifier.");
    const object = await media.get(cid);
    if (!object) throw new HttpError(404, "media_not_found", "Nothing stored under that identifier.");
    return new Response(new Uint8Array(object.bytes), {
      headers: {
        "Content-Type": object.contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${cid}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  });
}
