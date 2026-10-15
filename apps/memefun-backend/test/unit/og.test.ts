import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { errorBody, HttpError } from "../../api/http";
import { mountOg } from "../../api/read/og";
import type { MarketSnapshot, SnapshotState } from "../../api/read/snapshot";
import type { MediaStore } from "../../lib/media/store";
import type { Coin } from "../../shared/market-types";

const ADDRESS = "0xb2000000000000000000001b03710100dd44768f";

function fixture() {
  const coin = { address: ADDRESS, hidden: false, name: "MemeFun", symbol: "MEME", image: "",
    quote: { symbol: "ETH" }, terms: { mode: "creator", feeBps: 100 }, marketCapUsd: 5_000,
    athMarketCapUsd: 10_000, priceUsd: 0.000005, change24h: 2 } as unknown as Coin;
  const state = { byAddress: new Map([[ADDRESS, coin]]) } as unknown as SnapshotState;
  const ready = vi.fn(async () => state);
  const app = new Hono();
  app.onError((error, c) => error instanceof HttpError ? c.json(errorBody(error), error.status) : c.text(String(error), 500));
  mountOg(app, { snapshot: { ready } as unknown as MarketSnapshot, media: {} as MediaStore });
  return { app, coin, ready };
}

describe("cached share-card HTTP responses", () => {
  it("returns identical real PNGs and preserves cache headers for concurrent requests", async () => {
    const { app, ready } = fixture();
    const responses = await Promise.all(Array.from({ length: 3 }, () => app.request(`/og/coin/${ADDRESS}.png`)));
    const images = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
      return Buffer.from(await response.arrayBuffer());
    }));
    expect(images[0]?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(images[1]).toEqual(images[0]);
    expect(images[2]).toEqual(images[0]);
    // Every request must still check current visibility, even when the PNG is already cached.
    expect(ready).toHaveBeenCalledTimes(3);
  });

  it("continues validating visibility, addresses and milestones before using a cached image", async () => {
    const { app, coin } = fixture();
    expect((await app.request(`/og/coin/${ADDRESS}`)).status).toBe(200);
    coin.hidden = true;
    expect((await app.request(`/og/coin/${ADDRESS}`)).status).toBe(404);
    expect((await app.request("/og/coin/not-an-address")).status).toBe(400);
    expect((await app.request("/og/profile/not-an-address")).status).toBe(400);
    coin.hidden = false;
    expect((await app.request(`/og/milestone/${ADDRESS}/10001`)).status).toBe(404);
    expect((await app.request(`/og/milestone/${ADDRESS}/invalid`)).status).toBe(404);
    expect((await app.request(`/og/coin/0x${"00".repeat(20)}`)).status).toBe(404);
  });
});
