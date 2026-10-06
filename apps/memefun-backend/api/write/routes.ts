import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAddress } from "viem";
import { z } from "zod";

import type { AppStore } from "../../lib/app-store";
import { parseIpfsUri } from "../../lib/cid";
import { ImageRejected, processCoinImage } from "../../lib/media/image";
import { buildMetadata, encodeMetadata } from "../../lib/media/metadata";
import type { MediaStore } from "../../lib/media/store";
import { publicBucketUrl } from "../../lib/media/urls";
import { IMAGE_MAX_BYTES } from "../../shared/core/validation";
import type { Comment } from "../../shared/market-types";
import { HttpError, RateLimiter, clientIp, enforce, hashIp, parseAddress } from "../http";
import type { MarketSnapshot } from "../read/snapshot";
import { type AuthVariables, optionalAuth, requireAuth } from "./auth";
import type { Sessions } from "./session";

export interface WriteDeps {
  chainId: number;
  app: AppStore;
  media: MediaStore;
  snapshot: MarketSnapshot;
  sessions: Sessions;
  ipSalt: string;
}

/** Bucket CIDs are not publicly pinned: the mainnet document must use our own retrievable URL. */
function publishedBucketUrl(media: MediaStore, cid: string, value?: string): string {
  const url = publicBucketUrl(media, cid, value);
  if (!url) throw new HttpError(503, "media_public_url", "The public media address is unavailable. Try again later.");
  return url;
}

const HOUR = 3_600;
const UPLOADS_PER_HOUR = { anonymous: 20, signedIn: 60 };
const COMMENTS_PER_HOUR = 30;
const REPORTS_PER_HOUR = 10;
const COMMENT_MAX = 280;
/** Control, zero-width and bidirectional-override characters: never allowed in a comment. */
function hasHiddenChars(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) continue; // tabs and newlines become spaces
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
    if ((cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff) return true;
  }
  return false;
}

export function normalizeComment(raw: string): string {
  if (hasHiddenChars(raw)) throw new HttpError(422, "comment_invalid", "Remove hidden or control characters.");
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) throw new HttpError(422, "comment_empty", "Write something first.");
  if ([...text].length > COMMENT_MAX) throw new HttpError(422, "comment_too_long", `Comments can be up to ${COMMENT_MAX} characters.`);
  return text;
}

const metadataBody = z.object({
  name: z.string().max(200),
  symbol: z.string().max(50),
  description: z.string().max(2_000).optional(),
  image: z.string().max(200),
  x: z.string().max(200).optional(),
  telegram: z.string().max(200).optional(),
  website: z.string().max(500).optional(),
});

const reportBody = z.object({
  targetKind: z.enum(["coin", "comment"]),
  targetId: z.string().min(1).max(100),
  reason: z.enum(["scam", "impersonation", "offensive", "spam", "other"]),
  details: z.string().max(500).optional(),
});

export function writeRoutes(deps: WriteDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const burst = new RateLimiter();

  const quota = async (wallet: string | null, ipHash: string) => {
    const limit = wallet ? UPLOADS_PER_HOUR.signedIn : UPLOADS_PER_HOUR.anonymous;
    if ((await deps.app.recentUploads({ wallet, ipHash }, HOUR)) >= limit) {
      throw new HttpError(429, "upload_quota", "Upload limit reached for this hour. Try again later.");
    }
  };

  // ---------------------------------------------------------------------------------- image

  app.post(
    "/v1/media/image",
    bodyLimit({
      maxSize: IMAGE_MAX_BYTES + 64 * 1024,
      onError: () => {
        throw new HttpError(413, "image_too_large", "Use an image under 4 MB.");
      },
    }),
    optionalAuth(deps.sessions),
    async (c) => {
      const ipHash = hashIp(clientIp(c), deps.ipSalt);
      const wallet = c.get("wallet")?.toLowerCase() ?? null;
      enforce(burst, `image:${wallet ?? ipHash}`, 10, 60_000, "Too many uploads.");
      await quota(wallet, ipHash);

      let bytes: Uint8Array;
      const type = c.req.header("content-type") ?? "";
      if (type.startsWith("multipart/form-data")) {
        const form = await c.req.parseBody();
        const file = form.file;
        if (!(file instanceof File)) throw new HttpError(400, "image_missing", "Attach the image as the `file` field.");
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        bytes = new Uint8Array(await c.req.arrayBuffer());
      }

      let webp: Uint8Array;
      try {
        webp = (await processCoinImage(bytes)).webp;
      } catch (error) {
        if (error instanceof ImageRejected) throw new HttpError(422, "image_rejected", error.message);
        throw error;
      }
      const stored = await deps.media.put(webp, "image/webp");
      await deps.app.recordUpload({ cid: stored.cid, kind: "image", bytes: stored.bytes, uploader: wallet, ipHash });
      return c.json({ cid: stored.cid, uri: stored.uri, url: stored.url, bytes: stored.bytes }, 201);
    },
  );

  // ------------------------------------------------------------------------------- metadata

  app.post("/v1/media/metadata", bodyLimit({ maxSize: 16 * 1024, onError: () => { throw new HttpError(413, "body_too_large", "That request is too large."); } }), optionalAuth(deps.sessions), async (c) => {
    const ipHash = hashIp(clientIp(c), deps.ipSalt);
    const wallet = c.get("wallet")?.toLowerCase() ?? null;
    enforce(burst, `metadata:${wallet ?? ipHash}`, 10, 60_000, "Too many uploads.");
    await quota(wallet, ipHash);

    const parsed = metadataBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Send name, symbol, image and the optional description and links.");
    const built = buildMetadata(parsed.data);
    if (!built.ok) throw new HttpError(422, "metadata_invalid", "Some fields need attention.", built.errors);

    // Only images that came through POST /v1/media/image, so every coin image was re-encoded by us.
    const imageRef = parseIpfsUri(built.metadata.image)!;
    const imageCid = imageRef.cid;
    if (imageRef.path) throw new HttpError(422, "image_unknown", "Upload the image first.", { image: "Upload the image first." });
    if (!(await deps.app.hasUpload(imageCid, "image"))) throw new HttpError(422, "image_unknown", "Upload the image first.", { image: "Upload the image first." });

    const publishBucket = deps.chainId === 8453 && deps.media.kind === "bucket";
    const metadata = publishBucket ? { ...built.metadata, image: publishedBucketUrl(deps.media, imageCid) } : built.metadata;
    if (publishBucket) {
      const image = await deps.media.get(imageCid);
      if (!image || image.contentType !== "image/webp") throw new HttpError(422, "image_unknown", "Upload the image first.", { image: "Upload the image first." });
    }
    const stored = await deps.media.put(encodeMetadata(metadata), "application/json");
    const contractURI = publishBucket ? publishedBucketUrl(deps.media, stored.cid, stored.url) : stored.uri;
    await deps.app.saveMetadata({
      cid: stored.cid,
      name: built.metadata.name,
      symbol: built.metadata.symbol,
      description: built.metadata.description,
      imageUri: built.metadata.image,
      links: built.metadata.links,
      source: "api",
    });
    await deps.app.recordUpload({ cid: stored.cid, kind: "metadata", bytes: stored.bytes, uploader: wallet, ipHash });
    return c.json({ cid: stored.cid, contractURI, url: stored.url, metadata }, 201);
  });

  // ------------------------------------------------------------------------------- comments

  app.post("/v1/coins/:address/comments", bodyLimit({ maxSize: 4 * 1024, onError: () => { throw new HttpError(413, "body_too_large", "That request is too large."); } }), requireAuth(deps.sessions), async (c) => {
    const coinAddress = parseAddress(c.req.param("address"));
    const author = c.get("wallet")!.toLowerCase();
    const state = await deps.snapshot.ready();
    const coin = state.byAddress.get(coinAddress);
    if (!coin || coin.hidden) throw new HttpError(404, "coin_not_found", "No coin with this address on memefun.");

    const parsed = z.object({ body: z.string().max(4_000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Send the comment as `body`.");
    const body = normalizeComment(parsed.data.body);

    enforce(burst, `comment:${author}`, 1, 10_000, "You are commenting too fast.");
    if ((await deps.app.recentCommentCount(author, HOUR)) >= COMMENTS_PER_HOUR) {
      throw new HttpError(429, "comment_quota", "Comment limit reached for this hour. Try again later.");
    }
    if ((await deps.app.lastCommentBody(author, coinAddress)) === body) {
      throw new HttpError(409, "comment_duplicate", "You already posted that.");
    }
    const saved = await deps.app.addComment(coinAddress, author, body);
    const comment: Comment = {
      id: saved.id,
      coin: coin.address,
      author: getAddress(saved.author),
      body: saved.body,
      ts: saved.createdAt,
      isCreator: saved.author === coin.creator.toLowerCase(),
    };
    return c.json({ comment }, 201);
  });

  // -------------------------------------------------------------------------------- reports

  app.post("/v1/reports", bodyLimit({ maxSize: 4 * 1024, onError: () => { throw new HttpError(413, "body_too_large", "That request is too large."); } }), optionalAuth(deps.sessions), async (c) => {
    const ipHash = hashIp(clientIp(c), deps.ipSalt);
    const parsed = reportBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Send targetKind, targetId and a reason.");
    const report = parsed.data;
    if (report.targetKind === "coin") {
      const state = await deps.snapshot.ready();
      if (!state.byAddress.has(parseAddress(report.targetId))) throw new HttpError(404, "coin_not_found", "No coin with this address on memefun.");
      report.targetId = report.targetId.toLowerCase();
    } else if (!/^\d{1,18}$/.test(report.targetId)) {
      throw new HttpError(400, "invalid_target", "That comment does not exist.");
    }
    if ((await deps.app.recentReportCount(ipHash, HOUR)) >= REPORTS_PER_HOUR) {
      throw new HttpError(429, "report_quota", "Report limit reached for this hour. Thank you, we are on it.");
    }
    const id = await deps.app.addReport({
      targetKind: report.targetKind,
      targetId: report.targetId,
      reason: report.reason,
      details: (report.details ?? "").replace(/\s+/g, " ").trim(),
      reporter: c.get("wallet")?.toLowerCase() ?? null,
      ipHash,
    });
    return c.json({ id, status: "received" }, 201);
  });

  return app;
}
