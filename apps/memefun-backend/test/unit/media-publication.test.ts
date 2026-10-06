import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";

import { HttpError, errorBody, originGuard } from "../../api/http";
import { mountMedia } from "../../api/media";
import { MarketSnapshot } from "../../api/read/snapshot";
import type { ReadStore } from "../../api/read/store";
import { writeRoutes } from "../../api/write/routes";
import { createSessions } from "../../api/write/session";
import { resolveMetadata } from "../../keeper/jobs/metadata";
import type { AppStore, MetadataRecord } from "../../lib/app-store";
import { cidV1Raw, parseIpfsUri } from "../../lib/cid";
import type { CoinRecord } from "../../lib/market/derive";
import { BucketMediaStore } from "../../lib/media/bucket";
import { LocalMediaStore } from "../../lib/media/local";
import { PinataR2MediaStore, type ObjectBucket } from "../../lib/media/remote";
import type { MediaObject, MediaStore } from "../../lib/media/store";
import { publicBucketUrl, storedMetadataCid } from "../../lib/media/urls";
import { getSqrtPriceAtTick } from "../../shared/core/uniswap/tickMath";

const BASE = "https://api.memefun.test";
const CID = cidV1Raw(new TextEncoder().encode("valid identifier"));
const DIR = mkdtempSync(join(tmpdir(), "memefun-publication-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function memoryBucket(): ObjectBucket & { objects: Map<string, MediaObject> } {
  const objects = new Map<string, MediaObject>();
  return { objects, put: async (key, bytes, contentType) => { objects.set(key, { bytes, contentType }); }, get: async key => objects.get(key) ?? null };
}

function fixture(chainId = 8453, media: MediaStore = new BucketMediaStore(memoryBucket(), BASE)) {
  const uploads = new Map<string, "image" | "metadata">(), docs = new Map<string, MetadataRecord>();
  const appStore = {
    recentUploads: async () => 0,
    hasUpload: vi.fn(async (cid: string, kind: "image" | "metadata") => uploads.get(cid) === kind),
    recordUpload: vi.fn(async (upload: { cid: string; kind: "image" | "metadata" }) => { uploads.set(upload.cid, upload.kind); }),
    saveMetadata: vi.fn(async (doc: MetadataRecord) => { docs.set(doc.cid, doc); }),
    metadataByCids: vi.fn(async (cids: string[]) => new Map(cids.flatMap(cid => docs.has(cid) ? [[cid, docs.get(cid)!] as const] : []))),
    coinMetadataCids: async () => new Map<string, string>(),
    moderation: async () => new Map(), setting: async () => null,
  };
  const app = new Hono();
  app.onError((error, c) => error instanceof HttpError ? c.json(errorBody(error), error.status) : c.json({ error: { code: "internal" } }, 500));
  app.use("*", originGuard(new Set(["https://memefun.test"])));
  mountMedia(app, media);
  app.route("/", writeRoutes({ chainId, app: appStore as unknown as AppStore, media, snapshot: {} as MarketSnapshot,
    sessions: createSessions("x".repeat(32)), ipSalt: "unit-test-ip-salt" }));
  return { app, media, appStore, uploads, docs };
}

async function imageUpload(f: ReturnType<typeof fixture>) {
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#0066ff" } }).png().toBuffer();
  const response = await f.app.request("/v1/media/image", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(png) });
  expect(response.status).toBe(201);
  return await response.json() as { cid: string; uri: string; url: string };
}

async function metadataUpload(f: ReturnType<typeof fixture>, image: string) {
  return f.app.request("/v1/media/metadata", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Based Frog", symbol: "FROG", description: "A coin", image }) });
}

function record(contractUri: string): CoinRecord {
  const owner = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  return { address: "0xb2000000000000000000001b03710100dd44768f", creator: owner, launcher: owner,
    quote: "0x0000000000000000000000000000000000000000", quoteIsCurrency0: true, mode: 0,
    module: "0x0000000000000000000000000000000000000000", feeBps: 100, platformShareBps: 2_000,
    referralShareBps: 2_500, creatorKeepBps: 0, protectionStartBps: 5_000, protectionDurationSec: 15,
    createdAt: 1_000_000, name: "Based Frog", symbol: "FROG", contractUri, startTick: 200_000,
    launchQuoteUsdE8: 300_000_000_000n, sqrtPriceX96: getSqrtPriceAtTick(200_000), poolQuote: 0n,
    poolCoins: 10n ** 27n, burned: 0n, athMarketCapUsdE8: 0n, volumeUsdE8: 0n, trades: 0,
    lastTradeAt: 1_000_000, holders: 0, feesTotal: 0n, platformFees: 0n, referralFees: 0n,
    creatorEarned: 0n, creatorClaimed: 0n, destinationEarned: 0n, buybacks: 0, buybackSpent: 0n,
    buybackBurned: 0n, floorQuote: 0n, floorNearTick: null, holdersReserved: 0n, holdersReturned: 0n,
    epochs: 0, devSold: false, snipers: 0, sameBlockBuys: 0 };
}

async function snapshot(f: ReturnType<typeof fixture>, contractUri: string) {
  const store = { quotes: async () => [{ address: "0x0000000000000000000000000000000000000000", kind: 0,
    decimals: 18, symbol: "ETH", name: "Ether", priceUsdE8: 300_000_000_000n }], coins: async () => [record(contractUri)],
    latestTimestamp: async () => 1_000_000, windows: async () => new Map(), sparklineCloses: async () => new Map(),
    coinsWithTransfersSince: async () => ({ coins: [], maxBlock: 1n }), holderStats: async () => new Map() } as unknown as ReadStore;
  return new MarketSnapshot({ store, app: f.appStore as unknown as AppStore, media: f.media, clock: () => 1_000_100_000 }).ready();
}

describe("mainnet bucket metadata publication", () => {
  it("publishes retrievable document and WebP HTTPS references while retaining validated internal IPFS references", async () => {
    const f = fixture(), image = await imageUpload(f), response = await metadataUpload(f, image.uri);
    expect(image.uri).toBe(`ipfs://${image.cid}`);
    expect(response.status).toBe(201);
    const result = await response.json() as { cid: string; contractURI: string; url: string; metadata: { image: string } };
    expect(result.contractURI).toBe(`${BASE}/media/${result.cid}`);
    expect(result.url).toBe(result.contractURI);
    expect(result.metadata.image).toBe(image.url);
    expect(f.docs.get(result.cid)?.imageUri).toBe(image.uri);
    const document = await f.app.request(result.contractURI, { headers: { origin: "https://external-wallet.test" } });
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toBe("application/json");
    const raw = new Uint8Array(await document.arrayBuffer());
    expect(cidV1Raw(raw)).toBe(result.cid);
    expect(JSON.parse(new TextDecoder().decode(raw))).toMatchObject({ name: "Based Frog", image: image.url });
    const fetchedImage = await f.app.request(image.url);
    expect(fetchedImage.status).toBe(200);
    expect(fetchedImage.headers.get("content-type")).toBe("image/webp");
    const imageBytes = new Uint8Array(await fetchedImage.arrayBuffer());
    expect(cidV1Raw(imageBytes)).toBe(image.cid);
    expect((await sharp(imageBytes).metadata()).width).toBe(512);
    const fetchFn = (async (url: string | URL | Request) => f.app.request(String(url))) as typeof fetch;
    const resolved = await resolveMetadata({ media: f.media }, result.contractURI, fetchFn);
    expect(resolved.cid).toBe(result.cid);
    expect(resolved.doc.image).toBe(image.url);
    expect(parseIpfsUri(resolved.imageUri!)?.cid).toBe(image.cid);
    // Immediate in-app metadata must work before any keeper coin→CID resolution exists.
    const state = await snapshot(f, result.contractURI);
    expect(state.coins[0]).toMatchObject({ description: "A coin", image: image.url });
    expect(f.appStore.metadataByCids).toHaveBeenCalledWith([result.cid]);
  });

  it("rejects an existing bucket object that was never recorded as an image upload", async () => {
    const f = fixture(), stored = await f.media.put(new Uint8Array([1, 2, 3]), "image/webp");
    const response = await metadataUpload(f, stored.uri);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "image_unknown" } });
    expect(f.appStore.saveMetadata).not.toHaveBeenCalled();
    expect(f.appStore.recordUpload).not.toHaveBeenCalled();
  });

  it("does not publish a recorded image that is unavailable or whose CID bytes were tampered", async () => {
    const bucket = memoryBucket(), f = fixture(8453, new BucketMediaStore(bucket, BASE)), image = await imageUpload(f);
    bucket.objects.set(image.cid, { bytes: new Uint8Array([9]), contentType: "image/webp" });
    expect((await metadataUpload(f, image.uri)).status).toBe(422);
    expect(f.appStore.saveMetadata).not.toHaveBeenCalled();
  });

  it.each([`ipfs://${CID}/image.webp`, `${BASE}/media/${CID}`, `https://evil.test/${CID}`, `ipfs://${CID}?x=1`])("rejects image reference %s", async image => {
    const f = fixture(); f.uploads.set(CID, "image");
    expect((await metadataUpload(f, image)).status).toBe(422);
    expect(f.appStore.saveMetadata).not.toHaveBeenCalled();
  });

  it.each(["http://api.memefun.test", "https://user:password@api.memefun.test", "https://api.memefun.test?secret=hidden", "https://api.memefun.test#fragment", `https://api.memefun.test/${"a".repeat(220)}`])("fails closed on public bucket URL configuration %s", async base => {
    const f = fixture(8453, new BucketMediaStore(memoryBucket(), base)), image = await imageUpload(f);
    const response = await metadataUpload(f, image.uri);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "media_public_url", message: "The public media address is unavailable. Try again later." } });
    expect(f.appStore.saveMetadata).not.toHaveBeenCalled();
  });

  it.each([84532, 31337])("keeps chain %i bucket metadata in IPFS form", async chainId => {
    const f = fixture(chainId), image = await imageUpload(f), response = await metadataUpload(f, image.uri);
    expect(response.status).toBe(201);
    const result = await response.json() as { cid: string; contractURI: string; metadata: { image: string } };
    expect(result.contractURI).toBe(`ipfs://${result.cid}`);
    expect(result.metadata.image).toBe(image.uri);
  });

  it("keeps mainnet local and publicly pinned stores in IPFS form", async () => {
    const bucket = memoryBucket();
    const pin = vi.fn(async (_url: string, init?: RequestInit) => {
      const file = (init!.body as FormData).get("file") as File;
      return new Response(JSON.stringify({ IpfsHash: cidV1Raw(new Uint8Array(await file.arrayBuffer())) }), { status: 200 });
    });
    for (const media of [new LocalMediaStore(DIR, "http://localhost:42069"),
      new PinataR2MediaStore({ pinataJwt: "unit-test-key", pinataGateway: "gateway.test", publicUrl: "https://media.memefun.test" }, bucket, pin)]) {
      const f = fixture(8453, media), image = await imageUpload(f), response = await metadataUpload(f, image.uri);
      expect(response.status).toBe(201);
      const result = await response.json() as { cid: string; contractURI: string; metadata: { image: string } };
      expect(result.contractURI).toBe(`ipfs://${result.cid}`);
      expect(result.metadata.image).toBe(image.uri);
    }
    expect(pin).toHaveBeenCalledTimes(2);
  });
});

describe("trusted bucket metadata CID lookup", () => {
  const media = new BucketMediaStore(memoryBucket(), BASE);
  it("accepts IPFS compatibility and only this store's exact public CID URL", () => {
    expect(storedMetadataCid(`ipfs://${CID}`, media)).toBe(CID);
    expect(storedMetadataCid(`${BASE}/media/${CID}`, media)).toBe(CID);
    expect(publicBucketUrl(media, CID)).toBe(`${BASE}/media/${CID}`);
    expect(storedMetadataCid(`${BASE}/media/${CID}`, { ...media, kind: "local", urlFor: cid => media.urlFor(cid) } as MediaStore)).toBeNull();
  });
  it.each([`http://api.memefun.test/media/${CID}`, `https://evil.test/media/${CID}`, `${BASE}/other/${CID}`,
    `${BASE}/media/${CID}?x=1`, `${BASE}/media/${CID}#x`, `https://user:password@api.memefun.test/media/${CID}`,
    `${BASE}/media/${CID}/metadata.json`, `${BASE}/media/not-a-cid`])("does not infer a trusted metadata CID from %s", async uri => {
    expect(storedMetadataCid(uri, media)).toBeNull();
    const f = fixture(); f.docs.set(CID, { cid: CID, name: "Based Frog", symbol: "FROG", description: "Must not display", imageUri: `ipfs://${CID}`, links: {}, source: "api" });
    const state = await snapshot(f, uri);
    expect(state.coins[0]?.description).toBe("");
    expect(state.coins[0]?.image).toBe("");
    expect(f.appStore.metadataByCids).toHaveBeenCalledWith([]);
  });
});
