import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { KeeperContext } from "../../keeper/context";
import { FetchRejected, loadUri, resolveMetadata, runMetadata } from "../../keeper/jobs/metadata";
import { cidV1Raw } from "../../lib/cid";
import { BucketMediaStore } from "../../lib/media/bucket";
import type { MediaObject } from "../../lib/media/store";
import { fakeHttps } from "./https-fixture";

const BASE = "https://api.memefun.test";
const COIN = "0x0000000000000000000000000000000000000001";

function fixture() {
  const objects = new Map<string, MediaObject>();
  const media = new BucketMediaStore({
    get: async cid => objects.get(cid) ?? null,
    put: async (cid, bytes, contentType) => { objects.set(cid, { bytes, contentType }); },
  }, BASE);
  const network = vi.fn(async () => { throw new Error("network must not be used for our stored objects"); });
  return { media, network, https: fakeHttps(network as typeof fetch) };
}

function queued(f: ReturnType<typeof fixture>, uri: string, cid: string) {
  const app = {
    knownCoinMetadata: async () => new Set([COIN]),
    enqueueCoinMetadata: vi.fn(),
    enqueueCoinMetadataBatch: vi.fn(),
    dueCoinMetadata: async () => [{ coin: COIN, contract_uri: uri, attempts: 0 }],
    metadataByCids: vi.fn(async () => new Map([[cid, { cid }]])),
    resolveCoinMetadata: vi.fn(async () => undefined),
    saveMetadata: vi.fn(async () => undefined),
  };
  const ctx = { media: f.media, app, index: { query: async (sql: string) => ({ rows: sql.includes("NOT EXISTS") ? [] : [{ address: COIN, name: "Coin", symbol: "COIN" }] }) }, log: vi.fn() } as unknown as KeeperContext;
  return { ctx, app };
}

describe("keeper canonical media URLs", () => {
  it("loads canonical HTTPS metadata and images from the authenticated store without network or redirects", async () => {
    const f = fixture();
    const webp = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#0066ff" } }).webp().toBuffer();
    const image = await f.media.put(webp, "image/webp");
    const document = await f.media.put(new TextEncoder().encode(JSON.stringify({ description: "A coin", image: image.url })), "application/json");
    const get = vi.spyOn(f.media, "get");
    const resolved = await resolveMetadata({ media: f.media }, document.url, f.https);
    expect(resolved.cid).toBe(document.cid);
    expect(resolved.doc.image).toBe(image.url);
    expect(resolved.imageUri).toMatch(/^ipfs:\/\//);
    expect(get).toHaveBeenCalledWith(document.cid);
    expect(get).toHaveBeenCalledWith(image.cid);
    expect(f.network).not.toHaveBeenCalled();
  });

  it("uses the already validated metadata record for canonical HTTPS uploads", async () => {
    const f = fixture();
    const document = await f.media.put(new TextEncoder().encode("{}"), "application/json");
    const q = queued(f, document.url, document.cid);
    const get = vi.spyOn(f.media, "get");
    await expect(runMetadata(q.ctx)).resolves.toEqual({ resolved: 1, failed: 0 });
    expect(q.app.metadataByCids).toHaveBeenCalledWith([document.cid]);
    expect(q.app.resolveCoinMetadata).toHaveBeenCalledWith(COIN, "resolved", { cid: document.cid });
    expect(q.app.saveMetadata).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("preserves the byte limit and never falls back to the network for a missing canonical object", async () => {
    const f = fixture();
    const document = await f.media.put(new Uint8Array(65_537), "application/json");
    await expect(loadUri({ media: f.media }, document.url, 65_536, f.https)).rejects.toThrow("too large");
    const missing = f.media.urlFor(cidV1Raw(new TextEncoder().encode("missing")));
    await expect(loadUri({ media: f.media }, missing, 65_536, f.https)).rejects.toThrow("not found");
    expect(f.network).not.toHaveBeenCalled();
  });

  it("rejects IPFS directory paths even when the parent CID has validated metadata", async () => {
    const f = fixture();
    const document = await f.media.put(new TextEncoder().encode("{}"), "application/json");
    const uri = `${document.uri}/image.webp`;
    await expect(loadUri({ media: f.media }, uri, 65_536, f.https)).rejects.toBeInstanceOf(FetchRejected);
    const q = queued(f, uri, document.cid);
    await expect(runMetadata(q.ctx)).resolves.toEqual({ resolved: 0, failed: 1 });
    expect(q.app.metadataByCids).not.toHaveBeenCalled();
    expect(q.app.resolveCoinMetadata).toHaveBeenCalledWith(COIN, "unsupported", expect.objectContaining({ error: "IPFS paths inside directories are not supported" }));
  });

  it.each(["https://foreign.test/media/", `${BASE}/foreign/`])("keeps untrusted URL redirects rejected for %s", async prefix => {
    const f = fixture();
    const document = await f.media.put(new TextEncoder().encode("{}"), "application/json");
    const redirect = vi.fn(async () => new Response("", { status: 302, headers: { location: document.url } }));
    const get = vi.spyOn(f.media, "get");
    await expect(loadUri({ media: f.media }, `${prefix}${document.cid}`, 65_536, fakeHttps(redirect as typeof fetch))).rejects.toBeInstanceOf(FetchRejected);
    expect(redirect).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });
});
