import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const previous = process.env.MEMEFUN_SHARP_CONCURRENCY;
const previousConcurrency = sharp.concurrency();

beforeEach(() => {
  vi.resetModules();
  delete process.env.MEMEFUN_SHARP_CONCURRENCY;
});
afterEach(() => {
  sharp.concurrency(previousConcurrency);
  if (previous === undefined) delete process.env.MEMEFUN_SHARP_CONCURRENCY;
  else process.env.MEMEFUN_SHARP_CONCURRENCY = previous;
});

describe("image processing memory configuration", () => {
  it("preserves platform concurrency unless explicitly configured", async () => {
    sharp.concurrency(2);
    const { default: configured } = await import("../../lib/media/sharp");
    expect(configured.concurrency()).toBe(2);
    expect(configured.cache().memory.max).toBe(8);
  });

  it("bounds image-processing threads and still produces a valid coin image", async () => {
    process.env.MEMEFUN_SHARP_CONCURRENCY = "1";
    const { default: configured } = await import("../../lib/media/sharp");
    const { processCoinImage } = await import("../../lib/media/image");
    expect(configured.concurrency()).toBe(1);
    const input = await configured({ create: { width: 800, height: 800, channels: 3, background: "#184df5" } }).png().toBuffer();
    const image = await processCoinImage(input);
    const metadata = await configured(image.webp).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 512, height: 512 });
  });

  it.each(["0", "9", "1.5", "bad"])("rejects an unbounded or invalid image-thread setting: %s", async value => {
    process.env.MEMEFUN_SHARP_CONCURRENCY = value;
    await expect(import("../../lib/media/sharp")).rejects.toThrow("MEMEFUN_SHARP_CONCURRENCY");
  });
});
