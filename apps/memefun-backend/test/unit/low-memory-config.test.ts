import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAppPool, createReadPool, ponderPoolConfig } from "../../lib/db";

const settings = ["MEMEFUN_PONDER_POOL_MAX", "MEMEFUN_DB_READ_POOL_MAX", "MEMEFUN_DB_APP_POOL_MAX", "MEMEFUN_DB_IDLE_TIMEOUT_MS"];
const saved = { ...process.env };

beforeEach(() => {
  for (const name of settings) delete process.env[name];
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
  process.env.DATABASE_SCHEMA = "memefun_mainnet";
});
afterEach(() => { process.env = { ...saved }; });

describe("low-memory database configuration", () => {
  it("keeps existing pool defaults and read-only transaction guards when no tuning is set", async () => {
    const read = createReadPool(), app = createAppPool();
    try {
      expect(ponderPoolConfig()).toEqual({ max: 20, idleTimeoutMillis: 10_000 });
      expect(read.options.max).toBe(10);
      expect(app.options.max).toBe(10);
      expect(read.options.idleTimeoutMillis).toBe(10_000);
      expect(read.options.options).toContain("default_transaction_read_only=on");
      expect(read.options.options).toContain("statement_timeout=5000");
      expect(app.options.options).toContain("statement_timeout=10000");
    } finally { await Promise.all([read.end(), app.end()]); }
  });

  it("allows fewer idle connections while keeping the keeper's explicit lock headroom", async () => {
    process.env.MEMEFUN_PONDER_POOL_MAX = "8";
    process.env.MEMEFUN_DB_READ_POOL_MAX = "3";
    process.env.MEMEFUN_DB_APP_POOL_MAX = "2";
    process.env.MEMEFUN_DB_IDLE_TIMEOUT_MS = "2000";
    const read = createReadPool(), app = createAppPool(), keeper = createAppPool({ max: 4 });
    try {
      expect(ponderPoolConfig()).toEqual({ max: 8, idleTimeoutMillis: 2_000 });
      expect(read.options.max).toBe(3);
      expect(app.options.max).toBe(2);
      expect(keeper.options.max).toBe(4);
      expect(read.options.idleTimeoutMillis).toBe(2_000);
      expect(keeper.options.idleTimeoutMillis).toBe(2_000);
      // This is a released-client pool timeout, not a server setting that terminates a
      // checked-out session while it holds a transaction or a keeper advisory lock.
      expect(keeper.options.options).not.toContain("idle_session_timeout");
      expect(keeper.options.options).not.toContain("idle_in_transaction_session_timeout");
    } finally { await Promise.all([read.end(), app.end(), keeper.end()]); }
  });

  it.each(["0", "2", "7", "8.5", "101", "no"])("rejects a Ponder budget that could starve its internal pools: %s", value => {
    process.env.MEMEFUN_PONDER_POOL_MAX = value;
    expect(() => ponderPoolConfig()).toThrow("MEMEFUN_PONDER_POOL_MAX");
  });

  it("rejects unsafe API pool and idle-timeout settings before creating clients", () => {
    process.env.MEMEFUN_DB_READ_POOL_MAX = "1";
    expect(() => createReadPool()).toThrow("MEMEFUN_DB_READ_POOL_MAX");
    process.env.MEMEFUN_DB_APP_POOL_MAX = "0";
    expect(() => createAppPool()).toThrow("MEMEFUN_DB_APP_POOL_MAX");
    process.env.MEMEFUN_DB_IDLE_TIMEOUT_MS = "999";
    expect(() => ponderPoolConfig()).toThrow("MEMEFUN_DB_IDLE_TIMEOUT_MS");
  });
});
