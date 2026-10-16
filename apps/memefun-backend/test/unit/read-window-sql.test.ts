import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createReadStore, type WindowAggregates } from "../../api/read/store";
import type { Queryable } from "../../lib/db";
import { aggregatePoolId } from "../../lib/market/derive";

interface Database {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
// Use the exact PostgreSQL engine already pinned by Ponder, entirely in memory and without
// a socket, local environment loading, production credentials or a database migration.
const requirePonder = createRequire(realpathSync("node_modules/ponder/package.json"));
const { PGlite } = requirePonder("@electric-sql/pglite") as { PGlite: new () => Database };
const NOW = 1_000_000;
const COIN = "0xb200000000000000000000000000000000000001";
const EMPTY = "0xb200000000000000000000000000000000000002";
const AGGREGATE = aggregatePoolId(COIN);
const POOL_A = `0x${"11".repeat(32)}`;
const POOL_B = `0x${"22".repeat(32)}`;
let db: Database;
let calls: Array<{ sql: string; params: unknown[] }>;
const store = createReadStore({ query: async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params });
  return db.query(sql, params);
} } as unknown as Queryable);

async function candle(pool: string, interval: number, bucket: number, volume: number, close: number, trades = 1, buys = 1) {
  await db.query("INSERT INTO candle VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [COIN, pool, interval, bucket, String(close), String(volume), trades, buys]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE candle (coin text NOT NULL, pool_id text NOT NULL, interval integer NOT NULL,
    bucket integer NOT NULL, close_usd_e_18 numeric NOT NULL, volume_usd_e_8 numeric NOT NULL,
    trades integer NOT NULL, buys integer NOT NULL, PRIMARY KEY (pool_id, interval, bucket));
    CREATE INDEX candle_coin_idx ON candle (coin, interval, bucket);`);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => { calls = []; await db.exec("TRUNCATE candle"); });

const emptyWindows: WindowAggregates = { volume24hUsdE8: 0n, trades24h: 0, buys24h: 0,
  volume1hUsdE8: 0n, trades15m: 0, priceAgo: { m5: null, h1: null, h24: null } };

async function boundaries(pool: string, multiplier = 1) {
  await candle(pool, 300, NOW - 86_400 - 300, 1 * multiplier, 1, 1, 1);
  await candle(pool, 300, NOW - 86_400 - 299, 2 * multiplier, 2, 2, 1);
  await candle(pool, 300, NOW - 1_000, 3 * multiplier, 3, 3, 2);
  for (const [offset, close, volume] of [
    [86_400 + 61, 100, 1], [86_400 + 60, 101, 2], [86_400 + 59, 102, 3],
    [3_600 + 60, 201, 4], [3_600 + 59, 202, 5], [900 + 60, 250, 6],
    [900 + 59, 251, 7], [300 + 60, 301, 8], [300 + 59, 302, 9], [20, 303, 10],
  ]) await candle(pool, 60, NOW - offset!, volume! * multiplier, close! * multiplier);
}

describe("rolling windows against real PostgreSQL semantics", () => {
  it("preserves exact open/closed boundaries for aggregate coins", async () => {
    await boundaries(AGGREGATE);
    await candle(POOL_A, 300, NOW, 999, 999);
    expect((await store.windows([COIN], NOW)).get(COIN)).toEqual({
      volume24hUsdE8: 5n, trades24h: 5, buys24h: 3, volume1hUsdE8: 45n, trades15m: 4,
      priceAgo: { m5: 301n, h1: 201n, h24: 101n },
    });
  });

  it("keeps per-pool amounts independent from aggregate and other quote pools", async () => {
    await boundaries(AGGREGATE);
    await boundaries(POOL_A, 2);
    await candle(POOL_B, 60, NOW - 200_000, 900, 55);
    const result = await store.marketWindows!([POOL_A, POOL_B], NOW);
    expect(result.get(POOL_A)).toEqual({ volume24hUsdE8: 10n, trades24h: 5, buys24h: 3,
      volume1hUsdE8: 90n, trades15m: 4, priceAgo: { m5: 602n, h1: 402n, h24: 202n } });
    expect(result.get(POOL_B)).toEqual({ ...emptyWindows, priceAgo: { m5: 55n, h1: 55n, h24: 55n } });
  });

  it("returns zeros and null closes for a coin or pool without candles", async () => {
    expect((await store.windows([EMPTY], NOW)).get(EMPTY)).toEqual(emptyWindows);
    expect((await store.marketWindows!([POOL_A], NOW)).get(POOL_A)).toEqual(emptyWindows);
  });

  it("does no SQL work for empty windows or sparklines", async () => {
    expect((await store.windows([], NOW)).size).toBe(0);
    expect((await store.marketWindows!([], NOW)).size).toBe(0);
    expect((await store.sparklineCloses([], NOW)).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("advances rolling windows without changing the last closed price rule", async () => {
    await boundaries(AGGREGATE);
    const result = (await store.windows([COIN], NOW + 86_400)).get(COIN)!;
    expect(result.volume24hUsdE8).toBe(0n);
    expect(result.volume1hUsdE8).toBe(0n);
    expect(result.trades15m).toBe(0);
    expect(result.priceAgo.m5).toBe(303n);
    expect(result.priceAgo.h1).toBe(303n);
    expect(result.priceAgo.h24).toBe(302n); // The current 60-second candle has not closed at NOW.
  });

  it("keeps the sparkline's strict overlap boundary and aggregate namespace", async () => {
    const from = NOW - 86_400;
    await candle(AGGREGATE, 900, from - 900, 0, 19);
    await candle(AGGREGATE, 900, from - 899, 0, 20);
    await candle(AGGREGATE, 900, NOW - 10, 0, 21);
    await candle(POOL_A, 900, NOW - 9, 0, 99);
    expect((await store.sparklineCloses([COIN], from)).get(COIN)).toEqual([
      { bucket: from - 899, close: 20n }, { bucket: NOW - 10, close: 21n },
    ]);
  });

  it("uses existing index bucket bounds for recent sums and all historical seeks", async () => {
    await db.query(`INSERT INTO candle SELECT $1, $2, 60, n * 60, n, 1, 1, 1 FROM generate_series(0, 20_000) n`, [COIN, POOL_A]);
    await db.query(`INSERT INTO candle SELECT $1, $2, 300, n * 300, n, 1, 1, 1 FROM generate_series(0, 4_000) n`, [COIN, POOL_A]);
    await db.exec("ANALYZE candle");
    await store.marketWindows!([POOL_A], NOW);
    const query = calls.at(-1)!;
    const result = await db.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params);
    const conditions: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "Index Cond") conditions.push(String(child));
        else visit(child);
      }
    };
    visit(result.rows[0]?.["QUERY PLAN"]);
    expect(conditions.filter(condition => condition.includes("bucket"))).toHaveLength(5);
    expect(conditions.some(condition => /"?interval"? = 300/.test(condition) && condition.includes("bucket >"))).toBe(true);
    expect(conditions.filter(condition => condition.includes("bucket <="))).toHaveLength(3);
  });
});
