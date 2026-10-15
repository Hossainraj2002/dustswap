import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PngCache } from "../../api/read/og-cache";

function deferred() {
  let resolve!: (value: Buffer) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Buffer>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("bounded share-card PNG cache", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("reuses PNGs without extending their freshness deadline on hits", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 4, maxBytes: 100 });
    const create = vi.fn(async () => Buffer.from("card"));
    const first = await cache.getOrCreate("a", create);
    await vi.advanceTimersByTimeAsync(900);
    expect(await cache.getOrCreate("a", create)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
    await cache.getOrCreate("a", create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("starts TTL when rendering finishes and releases expired images while idle", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 4, maxBytes: 100 });
    const render = deferred();
    const task = cache.getOrCreate("a", () => render.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cache.size).toBe(0);
    render.resolve(Buffer.alloc(20));
    await task;
    await vi.advanceTimersByTimeAsync(999);
    expect(cache.byteLength).toBe(20);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts the least recently used image at the entry limit", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 2, maxBytes: 100 });
    const a = vi.fn(async () => Buffer.from("a"));
    const b = vi.fn(async () => Buffer.from("b"));
    await cache.getOrCreate("a", a);
    await cache.getOrCreate("b", b);
    await cache.getOrCreate("a", a);
    await cache.getOrCreate("c", async () => Buffer.from("c"));
    expect(cache.size).toBe(2);
    await cache.getOrCreate("a", a);
    expect(a).toHaveBeenCalledTimes(1);
    await cache.getOrCreate("b", b);
    expect(b).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it("evicts enough least recently used images to satisfy the byte cap", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 10, maxBytes: 10 });
    const a = vi.fn(async () => Buffer.alloc(4));
    const b = vi.fn(async () => Buffer.alloc(4));
    const c = vi.fn(async () => Buffer.alloc(7));
    await cache.getOrCreate("a", a);
    await cache.getOrCreate("b", b);
    await cache.getOrCreate("c", c);
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(7);
    await cache.getOrCreate("c", c);
    expect(c).toHaveBeenCalledTimes(1);
    await cache.getOrCreate("a", a);
    expect(a).toHaveBeenCalledTimes(2);
    expect(cache.byteLength).toBe(4);
  });

  it("deduplicates concurrent rendering of the same card", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 4, maxBytes: 100 });
    const render = deferred();
    const create = vi.fn(() => render.promise);
    const tasks = Array.from({ length: 20 }, () => cache.getOrCreate("a", create));
    expect(cache.pendingCount).toBe(1);
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    const png = Buffer.from("card");
    render.resolve(png);
    expect(await Promise.all(tasks)).toEqual(Array.from({ length: 20 }, () => png));
    expect(cache.pendingCount).toBe(0);
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(4);
  });

  it("shares a failed render, then allows retry without caching the error", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 4, maxBytes: 100 });
    const render = deferred();
    const first = cache.getOrCreate("a", () => render.promise);
    const second = cache.getOrCreate("a", () => render.promise);
    const results = Promise.allSettled([first, second]);
    render.reject(new Error("renderer unavailable"));
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(cache.pendingCount).toBe(0);
    expect(cache.size).toBe(0);
    expect(await cache.getOrCreate("a", async () => Buffer.from("retry"))).toEqual(Buffer.from("retry"));
  });

  it("cleans up a synchronous render exception and permits retry", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 4, maxBytes: 100 });
    await expect(cache.getOrCreate("a", () => { throw new Error("bad image"); })).rejects.toThrow("bad image");
    expect(cache.pendingCount).toBe(0);
    expect(await cache.getOrCreate("a", async () => Buffer.from("retry"))).toEqual(Buffer.from("retry"));
  });

  it("returns oversized PNGs without retaining them or evicting useful images", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 4, maxBytes: 10 });
    const small = vi.fn(async () => Buffer.alloc(3));
    const large = vi.fn(async () => Buffer.alloc(11));
    await cache.getOrCreate("small", small);
    expect((await cache.getOrCreate("large", large)).byteLength).toBe(11);
    await cache.getOrCreate("small", small);
    await cache.getOrCreate("large", large);
    expect(small).toHaveBeenCalledTimes(1);
    expect(large).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(3);
  });

  it("bounds pending-key tracking without queueing or rejecting distinct requests", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 2, maxBytes: 10, maxPending: 1 });
    const render = deferred();
    const first = cache.getOrCreate("slow", () => render.promise);
    const second = cache.getOrCreate("fast", async () => Buffer.from("fast"));
    expect(await second).toEqual(Buffer.from("fast"));
    expect(cache.pendingCount).toBe(1);
    expect(cache.getOrCreate("slow", async () => Buffer.from("duplicate"))).toBe(first);
    render.resolve(Buffer.from("slow"));
    await first;
    expect(cache.pendingCount).toBe(0);
    expect(cache.size).toBe(2);
    expect(cache.byteLength).toBe(8);
  });

  it("keeps one cleanup timer and releases every entry at its own deadline", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 4, maxBytes: 100 });
    await cache.getOrCreate("a", async () => Buffer.alloc(5));
    await vi.advanceTimersByTimeAsync(500);
    await cache.getOrCreate("b", async () => Buffer.alloc(8));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(8);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears retained bytes and the expiration timer", async () => {
    const cache = new PngCache({ ttlMs: 1_000, maxEntries: 4, maxBytes: 100 });
    await cache.getOrCreate("a", async () => Buffer.alloc(5));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unsafe or disabled limits instead of silently retaining unbounded data", () => {
    for (const invalid of [0, -1, Infinity, 0.5, NaN]) {
      expect(() => new PngCache({ ttlMs: invalid, maxEntries: 2, maxBytes: 10 })).toThrow();
      expect(() => new PngCache({ ttlMs: 1_000, maxEntries: invalid, maxBytes: 10 })).toThrow();
      expect(() => new PngCache({ ttlMs: 1_000, maxEntries: 2, maxBytes: invalid })).toThrow();
      expect(() => new PngCache({ ttlMs: 1_000, maxEntries: 2, maxBytes: 10, maxPending: invalid })).toThrow();
    }
    expect(() => new PngCache({ ttlMs: 2_147_483_648, maxEntries: 2, maxBytes: 10 })).toThrow();
  });
});
