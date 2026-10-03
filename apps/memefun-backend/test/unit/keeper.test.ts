import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { FetchRejected, loadUri, resolveMetadata } from "../../keeper/jobs/metadata";
import { needsUpdate, nextManualPrice } from "../../keeper/jobs/stockPrices";
import { decimalToE8, devPriceSource, httpPriceSource, readJsonPath } from "../../keeper/prices";
import { LocalMediaStore } from "../../lib/media/local";
import { PinataR2MediaStore } from "../../lib/media/remote";
import type { MediaObject } from "../../lib/media/store";

describe("stock prices", () => {
  it("parse decimal USD exactly", () => {
    expect(decimalToE8("241.104")).toBe(24_110_400_000n);
    expect(decimalToE8("0.00000001")).toBe(1n);
    expect(decimalToE8("1.123456789")).toBe(112_345_678n); // beyond 8 decimals is cut, never rounded up
    expect(decimalToE8("-5")).toBeNull();
    expect(decimalToE8("0")).toBeNull();
    expect(decimalToE8("1e3")).toBeNull();
  });

  it("read nested JSON paths", () => {
    expect(readJsonPath({ data: { nav: "1.5" } }, "data.nav")).toBe("1.5");
    expect(readJsonPath({ data: null }, "data.nav")).toBeUndefined();
    expect(readJsonPath({ price: 2 }, "price")).toBe(2);
  });

  it("an HTTP source fills the URL and reads the number or string", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ data: { nav: url.includes("AAPLc") ? "243.5" : 99.25 } }), { status: 200 });
    }) as typeof fetch;
    const source = httpPriceSource({ url: "https://nav.example/{symbol}?token={address}", path: "data.nav" }, fake);
    expect(await source.usdE8({ address: "0xabc", symbol: "AAPLc", currentUsdE8: 1n, nowSec: 0 })).toBe(24_350_000_000n);
    expect(await source.usdE8({ address: "0xdef", symbol: "TSLAc", currentUsdE8: 1n, nowSec: 0 })).toBe(9_925_000_000n);
    expect(seen[0]).toBe("https://nav.example/AAPLc?token=0xabc");
    const down = httpPriceSource({ url: "https://nav.example/{symbol}", path: "x" }, (async () => new Response("", { status: 503 })) as typeof fetch);
    expect(await down.usdE8({ address: "0x1", symbol: "X", currentUsdE8: 1n, nowSec: 0 })).toBeNull();
  });

  it("the keeper moves at most 20% per update and only when it matters", () => {
    expect(nextManualPrice(100n * 10n ** 8n, 150n * 10n ** 8n)).toEqual({ next: 120n * 10n ** 8n, capped: true });
    expect(nextManualPrice(100n * 10n ** 8n, 50n * 10n ** 8n)).toEqual({ next: 80n * 10n ** 8n, capped: true });
    expect(nextManualPrice(100n * 10n ** 8n, 101n * 10n ** 8n)).toEqual({ next: 101n * 10n ** 8n, capped: false });
    expect(needsUpdate(10_000n, 10_049n, 60)).toBe(false); // 0.49%
    expect(needsUpdate(10_000n, 10_050n, 60)).toBe(true); // 0.5%
    expect(needsUpdate(10_000n, 10_000n, 12 * 3_600)).toBe(true); // refresh before it goes stale
  });

  it("the dev source drifts at most about 1%", async () => {
    const source = devPriceSource();
    for (const nowSec of [0, 1_000, 5_000, 11_310, 90_000]) {
      const price = (await source.usdE8({ address: "0x1", symbol: "AAPLc", currentUsdE8: 10_000_000_000n, nowSec }))!;
      expect(price >= 9_900_000_000n && price <= 10_100_000_000n).toBe(true);
    }
  });
});

describe("metadata job", () => {
  const dir = mkdtempSync(join(tmpdir(), "memefun-keeper-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const media = new LocalMediaStore(dir, "http://localhost:42069");
  const noFetch = (async () => {
    throw new Error("no network in tests");
  }) as typeof fetch;

  it("reads ipfs, inline data and https, and refuses everything else", async () => {
    const stored = await media.put(new TextEncoder().encode('{"description":"gm"}'), "application/json");
    expect(new TextDecoder().decode(await loadUri({ media }, stored.uri, 1_000, noFetch))).toBe('{"description":"gm"}');
    expect(new TextDecoder().decode(await loadUri({ media }, "data:application/json;base64,eyJhIjoxfQ==", 1_000, noFetch))).toBe('{"a":1}');
    expect(new TextDecoder().decode(await loadUri({ media }, "data:application/json,%7B%22a%22%3A2%7D", 1_000, noFetch))).toBe('{"a":2}');
    await expect(loadUri({ media }, "http://insecure.example/x.json", 1_000, noFetch)).rejects.toBeInstanceOf(FetchRejected);
    await expect(loadUri({ media }, "ar://abc", 1_000, noFetch)).rejects.toBeInstanceOf(FetchRejected);
    await expect(loadUri({ media }, "https://user:pw@example.com/x", 1_000, noFetch)).rejects.toBeInstanceOf(FetchRejected);
    await expect(loadUri({ media }, stored.uri, 5, noFetch)).rejects.toBeInstanceOf(FetchRejected);
  });

  it("refuses an https document bigger than the cap, even without a content-length", async () => {
    const big = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(70_000)); c.close(); } }), { status: 200 })) as typeof fetch;
    await expect(loadUri({ media }, "https://example.com/meta.json", 65_536, big)).rejects.toThrow("too large");
  });

  it("sanitizes the document and re-encodes its image into our store", async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#ff8800" } }).png().toBuffer();
    const image = await media.put(new Uint8Array(png), "image/webp"); // stored bytes are PNG, the store does not care
    const doc = await media.put(
      new TextEncoder().encode(JSON.stringify({ name: "ignored", description: "A coin", image: image.uri, links: { x: "@coin", website: "javascript:alert(1)" } })),
      "application/json",
    );
    const result = await resolveMetadata({ media }, doc.uri, noFetch);
    expect(result.cid).toBe(doc.cid);
    expect(result.doc).toEqual({ description: "A coin", image: image.uri, links: { x: "coin" } });
    expect(result.imageUri).toMatch(/^ipfs:\/\/b/);
    const reencoded = await media.get(result.imageUri!.slice(7));
    expect((await sharp(reencoded!.bytes).metadata()).format).toBe("webp");
  });

  it("keeps the metadata when the image is bad, and rejects non-JSON", async () => {
    const doc = await media.put(new TextEncoder().encode(JSON.stringify({ description: "no picture", image: "https://example.com/missing.png" })), "application/json");
    const result = await resolveMetadata({ media }, doc.uri, noFetch);
    expect(result.imageUri).toBeNull();
    expect(result.doc.description).toBe("no picture");
    await expect(resolveMetadata({ media }, "data:application/json,not-json", noFetch)).rejects.toBeInstanceOf(FetchRejected);
  });
});

describe("Pinata + R2 media store", () => {
  const CID = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";

  function harness(pinResponse: Response | (() => Response)) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const bucket = new Map<string, MediaObject>();
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("pinFileToIPFS")) return typeof pinResponse === "function" ? pinResponse() : pinResponse;
      if (url.includes("/ipfs/")) return new Response(new Uint8Array([7, 7]), { status: 200, headers: { "content-type": "image/webp; charset=binary" } });
      return new Response("", { status: 404 });
    }) as never;
    const store = new PinataR2MediaStore(
      { pinataJwt: "jwt", pinataGateway: "gw.example", publicUrl: "https://media.example/" },
      {
        put: async (key, bytes, contentType) => void bucket.set(key, { bytes, contentType }),
        get: async (key) => bucket.get(key) ?? null,
      },
      fetchFn,
    );
    return { store, calls, bucket };
  }

  it("pins with CIDv1, mirrors the bytes to R2 under the CID, and serves from our domain", async () => {
    const { store, calls, bucket } = harness(new Response(JSON.stringify({ IpfsHash: CID }), { status: 200 }));
    const bytes = new TextEncoder().encode("hello world");
    const stored = await store.put(bytes, "application/json");
    expect(stored).toEqual({ cid: CID, uri: `ipfs://${CID}`, url: `https://media.example/${CID}`, bytes: 11, contentType: "application/json" });
    expect(calls[0]!.url).toBe("https://api.pinata.cloud/pinning/pinFileToIPFS");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    const form = calls[0]!.init!.body as FormData;
    expect(form.get("pinataOptions")).toBe('{"cidVersion":1}');
    expect(bucket.get(CID)).toEqual({ bytes, contentType: "application/json" });
    expect(await store.get(CID)).toEqual({ bytes, contentType: "application/json" });
  });

  it("reads through the gateway when R2 does not have it, and fails loudly on a bad pin", async () => {
    const { store } = harness(new Response("nope", { status: 500 }));
    expect(await store.get(CID)).toEqual({ bytes: new Uint8Array([7, 7]), contentType: "image/webp" });
    await expect(store.put(new Uint8Array([1]), "image/webp")).rejects.toThrow("HTTP 500");
    const bad = harness(new Response(JSON.stringify({ IpfsHash: "not-a-cid" }), { status: 200 }));
    await expect(bad.store.put(new Uint8Array([1]), "image/webp")).rejects.toThrow("no valid CID");
    expect(await store.get("../etc")).toBeNull();
  });
});
