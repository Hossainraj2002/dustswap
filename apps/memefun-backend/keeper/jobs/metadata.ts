import { cidV1Raw, parseIpfsUri } from "../../lib/cid";
import { rows } from "../../lib/db";
import { processCoinImage } from "../../lib/media/image";
import { type SanitizedMetadata, sanitizeMetadata } from "../../lib/media/metadata";
import { IMAGE_MAX_BYTES } from "../../shared/core/validation";
import type { KeeperContext } from "../context";

/**
 * Coin metadata for coins we did not see uploaded: reads each new coin's contractURI (IPFS, an
 * https URL, or an inline data: URI), keeps only what the app shows after validating it like our
 * own form, and re-encodes the image through the same pipeline as uploads, so every image the app
 * ever displays is one we produced. Failures retry with backoff, then give up.
 */
const MAX_JSON_BYTES = 64 * 1024;
const BACKOFF_SEC = [60, 300, 1_800, 7_200, 86_400];
const MAX_ATTEMPTS = 8;

export class FetchRejected extends Error {}

/** Reads at most `limit` bytes; anything larger is refused rather than truncated. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new FetchRejected(`too large (${declared} bytes)`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new FetchRejected(`too large (over ${limit} bytes)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchHttps(url: string, limit: number, fetchFn: typeof fetch): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new FetchRejected("only plain https URLs are fetched");
  const response = await fetchFn(parsed.toString(), { redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readCapped(response, limit);
}

/** The bytes behind a URI, from our media store (IPFS), the web, or inline data. */
export async function loadUri(ctx: Pick<KeeperContext, "media">, uri: string, limit: number, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  const ipfs = parseIpfsUri(uri);
  if (ipfs) {
    if (ipfs.path) throw new FetchRejected("IPFS paths inside directories are not supported");
    const object = await ctx.media.get(ipfs.cid);
    if (!object) throw new Error("not found on IPFS");
    if (object.bytes.byteLength > limit) throw new FetchRejected("too large");
    return object.bytes;
  }
  if (uri.startsWith("data:")) {
    const match = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/s.exec(uri);
    if (!match) throw new FetchRejected("malformed data URI");
    const bytes = match[2]?.includes(";base64") ? Buffer.from(match[3] ?? "", "base64") : Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8");
    if (bytes.byteLength > limit) throw new FetchRejected("too large");
    return new Uint8Array(bytes);
  }
  if (uri.startsWith("https://")) return fetchHttps(uri, limit, fetchFn);
  throw new FetchRejected("unsupported URI scheme");
}

export async function resolveMetadata(
  ctx: Pick<KeeperContext, "media">,
  contractUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ cid: string; doc: SanitizedMetadata; imageUri: string | null }> {
  const raw = await loadUri(ctx, contractUri, MAX_JSON_BYTES, fetchFn);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new FetchRejected("not JSON");
  }
  const doc = sanitizeMetadata(json);
  let imageUri: string | null = null;
  if (doc.image) {
    try {
      const { webp } = await processCoinImage(await loadUri(ctx, doc.image, IMAGE_MAX_BYTES, fetchFn));
      imageUri = (await ctx.media.put(webp, "image/webp")).uri;
    } catch {
      // A bad or unreachable image costs the coin its picture, not its metadata.
      imageUri = null;
    }
  }
  return { cid: parseIpfsUri(contractUri)?.cid ?? cidV1Raw(raw), doc, imageUri };
}

export async function runMetadata(ctx: KeeperContext): Promise<{ resolved: number; failed: number }> {
  const known = await ctx.app.knownCoinMetadata();
  const coins = await rows<{ address: string; contract_uri: string; name: string; symbol: string }>(
    ctx.index,
    `SELECT address, contract_uri, name, symbol FROM coin WHERE launched = true`,
  );
  const byAddress = new Map(coins.map((c) => [c.address, c]));
  for (const c of coins) if (!known.has(c.address)) await ctx.app.enqueueCoinMetadata(c.address, c.contract_uri);

  let resolved = 0;
  let failed = 0;
  for (const due of await ctx.app.dueCoinMetadata(20)) {
    const coin = byAddress.get(due.coin);
    const uriCid = parseIpfsUri(due.contract_uri)?.cid;
    try {
      // Uploaded through our API: already stored and validated.
      if (uriCid && (await ctx.app.metadataByCids([uriCid])).has(uriCid)) {
        await ctx.app.resolveCoinMetadata(due.coin, "resolved", { cid: uriCid });
        resolved += 1;
        continue;
      }
      const result = await resolveMetadata(ctx, due.contract_uri);
      await ctx.app.saveMetadata({
        cid: result.cid,
        name: coin?.name ?? "",
        symbol: coin?.symbol ?? "",
        description: result.doc.description,
        imageUri: result.imageUri,
        links: result.doc.links,
        source: "fetched",
      });
      await ctx.app.resolveCoinMetadata(due.coin, "resolved", { cid: result.cid });
      resolved += 1;
      ctx.log("metadata.resolved", { coin: due.coin, cid: result.cid, image: Boolean(result.imageUri) });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof FetchRejected || due.attempts + 1 >= MAX_ATTEMPTS;
      await ctx.app.resolveCoinMetadata(due.coin, permanent ? "unsupported" : "failed", {
        error: message.slice(0, 500),
        retryInSec: BACKOFF_SEC[Math.min(due.attempts, BACKOFF_SEC.length - 1)],
      });
      ctx.log("metadata.failed", { coin: due.coin, error: message, permanent });
    }
  }
  return { resolved, failed };
}
