import { cidV1Raw, parseIpfsUri } from "../../lib/cid";
import { rows } from "../../lib/db";
import { processCoinImage } from "../../lib/media/image";
import { type SanitizedMetadata, sanitizeMetadata } from "../../lib/media/metadata";
import { FetchRejected, fetchPublicHttps, type HttpsDependencies } from "../../lib/media/public-https";
import { storedMetadataCid } from "../../lib/media/urls";
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
const DISCOVERY_BATCH = 100;

export { FetchRejected };

/** The bytes behind a URI, from our media store (IPFS or its exact URL), the web, or inline data. */
export async function loadUri(ctx: Pick<KeeperContext, "media">, uri: string, limit: number, https: HttpsDependencies = {}): Promise<Uint8Array> {
  const ipfs = parseIpfsUri(uri);
  if (ipfs?.path) throw new FetchRejected("IPFS paths inside directories are not supported");
  const storedCid = storedMetadataCid(uri, ctx.media);
  if (storedCid) {
    const object = await ctx.media.get(storedCid);
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
  if (uri.startsWith("https://")) return fetchPublicHttps(uri, limit, https);
  throw new FetchRejected("unsupported URI scheme");
}

export async function resolveMetadata(
  ctx: Pick<KeeperContext, "media">,
  contractUri: string,
  https: HttpsDependencies = {},
): Promise<{ cid: string; doc: SanitizedMetadata; imageUri: string | null }> {
  const raw = await loadUri(ctx, contractUri, MAX_JSON_BYTES, https);
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
      const { webp } = await processCoinImage(await loadUri(ctx, doc.image, IMAGE_MAX_BYTES, https));
      imageUri = (await ctx.media.put(webp, "image/webp")).uri;
    } catch {
      // A bad or unreachable image costs the coin its picture, not its metadata.
      imageUri = null;
    }
  }
  return { cid: storedMetadataCid(contractUri, ctx.media) ?? cidV1Raw(raw), doc, imageUri };
}

export async function runMetadata(ctx: KeeperContext): Promise<{ resolved: number; failed: number }> {
  // Both schemas live in the same Postgres database. Keep the anti-join in Postgres instead of
  // downloading every historical coin and metadata key on each 15-second keeper pass.
  const discoveries = await rows<{ address: string; contract_uri: string }>(
    ctx.index,
    `SELECT c.address, c.contract_uri FROM coin c
      WHERE c.launched = true AND NOT EXISTS (
        SELECT 1 FROM memefun_app.coin_metadata m WHERE m.coin = c.address
      ) ORDER BY c.created_at, c.address LIMIT $1`,
    [DISCOVERY_BATCH],
  );
  if (discoveries.length > 0) await ctx.app.enqueueCoinMetadataBatch(discoveries.map((coin) => ({ coin: coin.address, contractUri: coin.contract_uri })));

  const dueCoins = await ctx.app.dueCoinMetadata(20);
  if (dueCoins.length === 0) return { resolved: 0, failed: 0 };
  // Names are needed only for this bounded work batch, including retries discovered earlier.
  const coins = await rows<{ address: string; name: string; symbol: string }>(ctx.index,
    `SELECT address, name, symbol FROM coin WHERE launched = true AND address = ANY($1::text[])`,
    [[...new Set(dueCoins.map((coin) => coin.coin))]],
  );
  const byAddress = new Map(coins.map((c) => [c.address, c]));

  let resolved = 0;
  let failed = 0;
  for (const due of dueCoins) {
    const coin = byAddress.get(due.coin);
    const ipfs = parseIpfsUri(due.contract_uri);
    const uriCid = ipfs?.path ? null : storedMetadataCid(due.contract_uri, ctx.media);
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
