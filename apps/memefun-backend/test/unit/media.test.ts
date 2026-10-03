import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { cidV1Raw } from "../../lib/cid";
import { ImageRejected, processCoinImage, sniffImageType } from "../../lib/media/image";
import { LocalMediaStore } from "../../lib/media/local";
import { buildMetadata, encodeMetadata, safeImageUri, sanitizeMetadata } from "../../lib/media/metadata";

const CID = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";

async function solid(format: "png" | "jpeg" | "webp" | "gif", size = 300, options: { exif?: boolean } = {}) {
  let image = sharp({ create: { width: size, height: size, channels: 3, background: { r: 200, g: 40, b: 90 } } });
  if (options.exif) image = image.withExif({ IFD0: { Copyright: "secret gps payload", Artist: "someone" } });
  return new Uint8Array(await image.toFormat(format).toBuffer());
}

describe("sniffImageType", () => {
  it("reads the real format from magic bytes", async () => {
    expect(sniffImageType(await solid("png"))).toBe("image/png");
    expect(sniffImageType(await solid("jpeg"))).toBe("image/jpeg");
    expect(sniffImageType(await solid("webp"))).toBe("image/webp");
    expect(sniffImageType(await solid("gif"))).toBe("image/gif");
  });

  it("refuses SVG and anything else, whatever it claims to be", () => {
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("GIF8"))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
  });
});

describe("processCoinImage", () => {
  it("re-encodes any accepted format to a 512 px WebP", async () => {
    for (const format of ["png", "jpeg", "webp", "gif"] as const) {
      const { webp, sourceType } = await processCoinImage(await solid(format, 900));
      expect(sourceType).toBe(`image/${format}`);
      const meta = await sharp(webp).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(512);
      expect(meta.height).toBe(512);
    }
  });

  it("drops EXIF and every other metadata block", async () => {
    const input = await solid("jpeg", 600, { exif: true });
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const { webp } = await processCoinImage(input);
    const meta = await sharp(webp).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(Buffer.from(webp).includes("secret gps payload")).toBe(false);
  });

  it("keeps only the first frame of an animation", async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 200, height: 200, channels: 3, background } }).png().toBuffer();
    const frames = await Promise.all(["#ff0000", "#00ff00", "#0000ff"].map(frame));
    const animated = await sharp(frames, { join: { animated: true } }).gif({ loop: 0, delay: 100 }).toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(3);
    const { webp } = await processCoinImage(new Uint8Array(animated));
    expect((await sharp(webp, { animated: true }).metadata()).pages ?? 1).toBe(1);
    // The first frame is red.
    const { data } = await sharp(webp).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[1]).toBeLessThan(40);
  });

  it("rejects bad input with a message for the person uploading", async () => {
    await expect(processCoinImage(new Uint8Array())).rejects.toBeInstanceOf(ImageRejected);
    await expect(processCoinImage(new TextEncoder().encode("<svg/>"))).rejects.toThrow("Use a PNG, JPG, WebP or GIF image.");
    await expect(processCoinImage(await solid("png", 32))).rejects.toThrow("at least 64 pixels");
    await expect(processCoinImage(new Uint8Array(4 * 1024 * 1024 + 1))).rejects.toThrow("under 4 MB");
    const truncated = (await solid("png", 400)).slice(0, 200);
    await expect(processCoinImage(truncated)).rejects.toBeInstanceOf(ImageRejected);
  });
});

describe("LocalMediaStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "memefun-media-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stores by CID and returns exactly the bytes", async () => {
    const store = new LocalMediaStore(dir, "http://localhost:42069/");
    const bytes = new TextEncoder().encode("hello world");
    const stored = await store.put(bytes, "application/json");
    expect(stored).toMatchObject({ cid: CID, uri: `ipfs://${CID}`, url: `http://localhost:42069/media/${CID}`, bytes: 11 });
    expect(await store.get(CID)).toEqual({ bytes, contentType: "application/json" });
  });

  it("never serves a file whose bytes no longer match its CID", async () => {
    const store = new LocalMediaStore(dir, "http://localhost:42069");
    await store.put(new TextEncoder().encode("hello world"), "application/json");
    writeFileSync(join(dir, CID), "tampered");
    expect(await store.get(CID)).toBeNull();
    expect(await store.get("../../etc/passwd")).toBeNull();
  });

  it("only stores the two content types the API produces", async () => {
    const store = new LocalMediaStore(dir, "http://localhost:42069");
    await expect(store.put(new Uint8Array([1]), "image/svg+xml")).rejects.toThrow();
    expect(cidV1Raw(new Uint8Array([1]))).toMatch(/^b/);
  });
});

describe("metadata", () => {
  const image = `ipfs://${CID}`;

  it("applies the launch form's own rules", () => {
    const ok = buildMetadata({ name: "  Based   Frog ", symbol: "$frog", description: "hi", image, x: "@frogonbase", telegram: "t.me/frog_chat", website: "frog.example" });
    expect(ok).toEqual({
      ok: true,
      metadata: {
        name: "Based Frog",
        symbol: "FROG",
        description: "hi",
        image,
        external_link: "https://frog.example/",
        links: { x: "frogonbase", telegram: "frog_chat", website: "https://frog.example/" },
      },
    });
    const bad = buildMetadata({ name: "", symbol: "a!", image: "https://evil.example/x.png", website: "http://insecure.example" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["image", "name", "symbol", "website"]);
  });

  it("encodes canonically, so equal metadata always has one CID", () => {
    const a = buildMetadata({ name: "Frog", symbol: "FROG", image, website: "frog.example", x: "frog" });
    const b = buildMetadata({ x: "frog", website: "frog.example", image, symbol: "FROG", name: "Frog" });
    if (!a.ok || !b.ok) throw new Error("expected valid metadata");
    expect(cidV1Raw(encodeMetadata(a.metadata))).toBe(cidV1Raw(encodeMetadata(b.metadata)));
  });

  it("sanitizes metadata from outside: unsafe images and invalid links are dropped", () => {
    expect(safeImageUri("javascript:alert(1)")).toBeUndefined();
    expect(safeImageUri("data:image/svg+xml;base64,PHN2Zy8+")).toBeUndefined();
    expect(safeImageUri("http://example.com/a.png")).toBeUndefined();
    expect(safeImageUri("https://user:pw@example.com/a.png")).toBeUndefined();
    expect(safeImageUri("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(safeImageUri(image)).toBe(image);

    const clean = sanitizeMetadata({
      description: "x".repeat(5_000),
      image: "javascript:alert(1)",
      links: { x: "not a handle!", telegram: "good_chat", website: "javascript:alert(1)" },
      evil: "<script>",
    });
    expect(clean).toEqual({ description: "", links: { telegram: "good_chat" } });
    expect(sanitizeMetadata(null)).toEqual({ description: "", links: {} });
    expect(sanitizeMetadata({ description: "gm", image, external_link: "https://frog.example" })).toEqual({
      description: "gm",
      image,
      external_link: "https://frog.example/",
      links: { website: "https://frog.example/" },
    });
  });
});
