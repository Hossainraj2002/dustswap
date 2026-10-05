/** Server-only provider access. Import this module only from Next route handlers. */
import { normalizeTweetResponse, parseTweetUrl, safeTweetMediaUrl, type TweetImport } from "@/core/tweet";

const MAX_JSON_BYTES = 256 * 1_024;
const MAX_IMAGE_BYTES = 4 * 1_024 * 1_024;
const CACHE_MS = 60 * 60 * 1_000;
const TIMEOUT_MS = 8_000;

export class TweetServiceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
  const stated = Number(response.headers.get("content-length"));
  if (Number.isFinite(stated) && stated > max) throw new TweetServiceError(422, "too_large", "The imported content is too large.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new TweetServiceError(422, "too_large", "The imported content is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export interface TweetServiceOptions {
  key: () => string | undefined;
  /** A strict per-process spending cap: default100 unique reads/day, approximately$0.10/day. */
  dailyLimit?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createTweetService(options: TweetServiceOptions) {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = Number.isFinite(options.dailyLimit) ? Math.max(0, Math.min(10_000, Math.floor(options.dailyLimit!))) : 100;
  const cache = new Map<string, { value: TweetImport; expires: number }>();
  const inflight = new Map<string, Promise<TweetImport>>();
  let budgetDay = -1;
  let reads = 0;

  async function importTweet(input: string): Promise<TweetImport> {
    let postId: string;
    try { ({ postId } = parseTweetUrl(input)); } catch (error) { throw new TweetServiceError(400, "invalid_post_url", error instanceof Error ? error.message : "Use a public X post link."); }
    const cached = cache.get(postId);
    if (cached && cached.expires > now()) return cached.value;
    const pending = inflight.get(postId);
    if (pending) return pending;
    const key = options.key();
    if (!key) throw new TweetServiceError(503, "tweet_import_unavailable", "X post import is not configured yet. You can still create a coin manually.");
    const today = Math.floor(now() / 86_400_000);
    if (today !== budgetDay) { budgetDay = today; reads = 0; }
    if (reads >= limit) throw new TweetServiceError(429, "daily_import_limit", "Today's X import budget is used up. Try tomorrow or create a coin manually.");
    reads += 1; // Reserve before starting any asynchronous call, including failed reads.
    const work = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await request(`https://api.getxapi.com/twitter/tweet/detail?id=${postId}`, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          signal: controller.signal, redirect: "error", cache: "no-store",
        });
        if (!response.ok) throw new TweetServiceError(response.status === 404 ? 404 : 502, "post_unavailable", "The post is unavailable. Use another public X post or try again later.");
        const payload: unknown = JSON.parse(new TextDecoder().decode(await boundedBytes(response, MAX_JSON_BYTES)));
        let value: TweetImport;
        try { value = normalizeTweetResponse(payload, postId); } catch { throw new TweetServiceError(422, "post_unverified", "We could not verify this public post and its author. Try another post."); }
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(postId, { value, expires: now() + CACHE_MS });
        return value;
      } catch (error) {
        if (error instanceof TweetServiceError) throw error;
        throw new TweetServiceError(502, "post_import_failed", "X import is temporarily unavailable. Try again later.");
      } finally { clearTimeout(timer); }
    })();
    inflight.set(postId, work);
    try { return await work; } finally { inflight.delete(postId); }
  }

  async function image(input: string): Promise<{ bytes: Uint8Array; type: string }> {
    const url = safeTweetMediaUrl(input);
    if (!url) throw new TweetServiceError(400, "invalid_media", "Choose an image from the imported X post.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await request(url, { signal: controller.signal, redirect: "error", cache: "no-store" });
      if (!response.ok) throw new TweetServiceError(502, "image_unavailable", "This post image is unavailable. Choose another image.");
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)) throw new TweetServiceError(422, "image_type", "Use a PNG, JPG, WebP or GIF post image.");
      const bytes = await boundedBytes(response, MAX_IMAGE_BYTES);
      const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const gif = new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
      const webp = new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
      if (!({ "image/png": png, "image/jpeg": jpeg, "image/gif": gif, "image/webp": webp }[type])) throw new TweetServiceError(422, "image_invalid", "This image could not be verified. Choose another image.");
      return { bytes, type };
    } catch (error) {
      if (error instanceof TweetServiceError) throw error;
      throw new TweetServiceError(502, "image_import_failed", "This image is temporarily unavailable. Choose another image.");
    } finally { clearTimeout(timer); }
  }
  return { importTweet, image };
}

export const tweetService = createTweetService({
  key: () => process.env.GETX_API_KEY || process.env.GETXAPI_API_KEY || process.env.GETXAPI_KEY,
  dailyLimit: Number(process.env.GETX_TWEET_DAILY_LIMIT ?? "100"),
});
