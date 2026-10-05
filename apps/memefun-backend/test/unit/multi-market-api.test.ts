import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { HttpError, errorBody } from "../../api/http";
import { type ReadDeps, readRoutes } from "../../api/read/routes";
import type { SnapshotState } from "../../api/read/snapshot";
import type { StoredTrade } from "../../api/read/store";
import type { MarketRecord } from "../../lib/market/derive";
import type { Coin } from "../../shared/market-types";

const ADDRESS = "0xb2000000000000000000001b03710100dd44768f";
const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ETH = "0x0000000000000000000000000000000000000000";
const USDC = "0x00000000000000000000000000000000000000c0";
const POOL_A = `0x${"11".repeat(32)}`;
const POOL_B = `0x${"22".repeat(32)}`;

function appFixture() {
  const coin = { address: ADDRESS, creator: OWNER, quote: { address: ETH, decimals: 18 }, openingMarketCapUsd: 5_000 } as unknown as Coin;
  const primary = { address: ADDRESS, poolId: POOL_A, quote: ETH, createdAt: 1_000 } as MarketRecord;
  const second = { address: ADDRESS, poolId: POOL_B, quote: USDC, createdAt: 1_000, quoteIsCurrency0: true,
    startTick: 0, launchQuoteUsdE8: 100_000_000n } as MarketRecord;
  const state = { nowSec: 1_300, byAddress: new Map([[ADDRESS, coin]]), records: new Map([[ADDRESS, primary]]),
    markets: new Map([[POOL_A, primary], [POOL_B, second]]),
    quotes: new Map([[ETH, { address: ETH, decimals: 18 }], [USDC, { address: USDC, decimals: 6 }]]) } as unknown as SnapshotState;
  const trades = vi.fn(async (_coin: string, options: { poolId?: string }) => [{ id: "b", coin: ADDRESS, poolId: options.poolId,
    quote: USDC, trader: OWNER, isBuy: true, kind: "trade", quoteAmount: 2_000_000n, coinAmount: 10n ** 18n,
    fee: 20_000n, feeBps: 100, priceUsdE18: 10n ** 13n, marketCapUsdE8: 10_000n * 10n ** 8n,
    timestamp: 1_100, txHash: `0x${"33".repeat(32)}`, inProtection: false, isCreator: false, blockNumber: 10n, logIndex: 1 } as StoredTrade]);
  const pool = vi.fn(async (_coin: string, poolId?: string) => ({ poolId: poolId!, quote: USDC, quoteIsCurrency0: true,
    startTick: 0, liquidity: 100n, sqrtPriceX96: 2n ** 96n, tick: 0, floors: [] }));
  const candles = vi.fn(async (_coin: string, _interval: number, _from: number, _metric: string, _poolId?: string) => []);
  const deps = { snapshot: { ready: async () => state }, store: { trades, pool, candles }, app: {}, settings: {}, poolManager: OWNER } as unknown as ReadDeps;
  const app = new Hono();
  app.onError((error, c) => error instanceof HttpError ? c.json(errorBody(error), error.status) : c.text(String(error), 500));
  app.route("/", readRoutes(deps));
  return { app, trades, pool, candles };
}

describe("selected market reads", () => {
  it("filters trades to the selected pool and uses that trade's quote decimals", async () => {
    const { app, trades } = appFixture();
    const response = await app.request(`/v1/coins/${ADDRESS}/trades?poolId=${POOL_B}`);
    expect(response.status).toBe(200);
    expect(trades.mock.calls[0]?.[1]).toMatchObject({ poolId: POOL_B });
    const body = await response.json() as { trades: unknown[] };
    expect(body.trades[0]).toMatchObject({ poolId: POOL_B, quoteAmount: 2, feeQuote: 0.02 });
  });

  it("returns the selected pool's asset and decimals", async () => {
    const { app, pool } = appFixture();
    const response = await app.request(`/v1/coins/${ADDRESS}/pool?poolId=${POOL_B}`);
    expect(response.status).toBe(200);
    expect(pool.mock.calls[0]).toEqual([ADDRESS, POOL_B]);
    const body = await response.json() as { pool: unknown };
    expect(body.pool).toMatchObject({ poolId: POOL_B, quoteDecimals: 6 });
  });

  it("passes pool identity to candles without mixing another market's prices", async () => {
    const { app, candles } = appFixture();
    const response = await app.request(`/v1/coins/${ADDRESS}/candles?poolId=${POOL_B}`);
    expect(response.status).toBe(200);
    expect(candles.mock.calls[0]?.at(-1)).toBe(POOL_B);
  });

  it("rejects a malformed pool or a pool that does not belong to the coin", async () => {
    const { app, trades } = appFixture();
    expect((await app.request(`/v1/coins/${ADDRESS}/trades?poolId=0x12`)).status).toBe(400);
    expect((await app.request(`/v1/coins/${ADDRESS}/trades?poolId=0x${"44".repeat(32)}`)).status).toBe(404);
    expect(trades).not.toHaveBeenCalled();
  });
});
