import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppStore } from "../../lib/app-store";
import { cidV1Raw } from "../../lib/cid";
import { migrate } from "../../lib/migrate";

// Deliberately accepts no DATABASE_URL, host or credentials: this suite cannot target a remote database.
const port = Number(process.env.MEMEFUN_QUOTA_TEST_PORT ?? "54339");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("MEMEFUN_QUOTA_TEST_PORT must be a local test port");
const database = `memefun_quota_test_${randomBytes(8).toString("hex")}`;
const DATABASE_NAME = /^memefun_quota_test_[a-f0-9]{16}$/;
const admin = new pg.Pool({ host: "127.0.0.1", port, user: "memefun", password: "memefun", database: "postgres", max: 1, connectionTimeoutMillis: 5_000 });
let first: pg.Pool;
let second: pg.Pool;
let created = false;
const WALLET = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const MIGRATION = "0006_upload_reservations.sql";

function assertOwnedDatabase() {
  if (!created || !DATABASE_NAME.test(database)) throw new Error("refusing to mutate a database not created by this test run");
}

beforeAll(async () => {
  if (!DATABASE_NAME.test(database)) throw new Error("invalid isolated test database name");
  await admin.query(`CREATE DATABASE "${database}"`).catch((error: unknown) => {
    throw new Error(`Quota integration needs local Postgres on 127.0.0.1:${port} with public memefun test credentials; no test database was created: ${String(error)}`);
  });
  created = true;
  const options = { host: "127.0.0.1", port, user: "memefun", password: "memefun", database, max: 8,
    connectionTimeoutMillis: 5_000, options: "-c search_path=memefun_app -c statement_timeout=15000" };
  first = new pg.Pool(options);
  second = new pg.Pool(options);
  await migrate(first);
});

beforeEach(async () => {
  assertOwnedDatabase();
  await first.query("TRUNCATE memefun_app.upload, memefun_app.upload_reservation");
});

afterAll(async () => {
  await Promise.allSettled([first?.end(), second?.end()]);
  try {
    if (created) {
      assertOwnedDatabase();
      await admin.query(`DROP DATABASE "${database}"`);
      created = false;
    }
  } finally { await admin.end(); }
});

async function count(key: string) {
  return Number((await first.query<{ n: string }>("SELECT COUNT(*) AS n FROM upload_reservation WHERE quota_key = $1", [key])).rows[0]!.n);
}

describe("upload reservations in real Postgres", () => {
  it.each(["image", "metadata"] as const)("counts repeated %s attempts while the upload ledger deduplicates the same CID", async kind => {
    const store = createAppStore(first);
    const cid = cidV1Raw(new TextEncoder().encode(`same ${kind} bytes`));
    for (let i = 0; i < 3; i += 1) {
      expect(await store.reserveUpload({ wallet: null, ipHash: "same-ip" }, 3, 3_600)).toBe(true);
      await store.recordUpload({ cid, kind, bytes: 10, uploader: null, ipHash: "same-ip" });
    }
    expect(await createAppStore(second).reserveUpload({ wallet: null, ipHash: "same-ip" }, 3, 3_600)).toBe(false);
    expect(await count("ip:same-ip")).toBe(3);
    expect(Number((await first.query("SELECT COUNT(*) AS n FROM upload")).rows[0].n)).toBe(1);
  });

  it("admits exactly the limit across simultaneous independent pools and stores", async () => {
    const a = createAppStore(first), b = createAppStore(second);
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).reserveUpload({ wallet: null, ipHash: "race-ip" }, 7, 3_600)));
    expect(results.filter(Boolean)).toHaveLength(7);
    expect(await count("ip:race-ip")).toBe(7);
  });

  it("serializes the same wallet across IPs and casing without charging rejected reservations", async () => {
    const a = createAppStore(first), b = createAppStore(second);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).reserveUpload({ wallet: i % 2 ? WALLET.toUpperCase() : WALLET, ipHash: `wallet-race-${i}` }, 5, 3_600)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await count(`wallet:${WALLET}`)).toBe(5);
    const ipRows = await first.query("SELECT COUNT(*) AS n FROM upload_reservation WHERE quota_key LIKE 'ip:wallet-race-%'");
    expect(Number(ipRows.rows[0].n)).toBe(5);
  });

  it("keeps wallet budgets independent while anonymous callers inherit signed network usage", async () => {
    const a = createAppStore(first), b = createAppStore(second);
    expect(await a.reserveUpload({ wallet: WALLET, ipHash: "shared-ip" }, 2, 3_600)).toBe(true);
    expect(await b.reserveUpload({ wallet: WALLET, ipHash: "different-ip" }, 2, 3_600)).toBe(true);
    expect(await a.reserveUpload({ wallet: WALLET, ipHash: "fresh-ip" }, 2, 3_600)).toBe(false);
    expect(await b.reserveUpload({ wallet: OTHER, ipHash: "shared-ip" }, 2, 3_600)).toBe(true);
    expect(await a.reserveUpload({ wallet: null, ipHash: "shared-ip" }, 2, 3_600)).toBe(false);
    expect(await b.reserveUpload({ wallet: null, ipHash: "unrelated-ip" }, 2, 3_600)).toBe(true);
    expect(await count("ip:fresh-ip")).toBe(0);
    expect(await count("ip:shared-ip")).toBe(2);
  });

  it("expires a rolling window instead of keeping a permanent quota or resetting at a clock boundary", async () => {
    const store = createAppStore(first);
    await first.query("INSERT INTO upload_reservation (quota_key, created_at) VALUES ('ip:expiry', clock_timestamp() - interval '3601 seconds'), ('ip:expiry', clock_timestamp() - interval '3500 seconds')");
    expect(await store.reserveUpload({ wallet: null, ipHash: "expiry" }, 2, 3_600)).toBe(true);
    expect(await count("ip:expiry")).toBe(2);
    expect(await store.reserveUpload({ wallet: null, ipHash: "expiry" }, 2, 3_600)).toBe(false);
    await first.query("UPDATE upload_reservation SET created_at = clock_timestamp() - interval '3601 seconds' WHERE quota_key = 'ip:expiry'");
    expect(await createAppStore(second).reserveUpload({ wallet: null, ipHash: "expiry" }, 2, 3_600)).toBe(true);
    expect(await count("ip:expiry")).toBe(1);
  });

  it("rolls back expired-row cleanup and releases transaction locks when reservation storage fails", async () => {
    await first.query("INSERT INTO upload_reservation (quota_key, created_at) VALUES ('ip:rollback', clock_timestamp() - interval '2 hours')");
    const failing = createAppStore({ query: first.query.bind(first), connect: async () => {
      const client = await first.connect();
      return { query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("INSERT INTO upload_reservation")) throw new Error("injected reservation write failure");
        return client.query(sql, params);
      }, release: () => client.release() };
    } } as unknown as pg.Pool);
    await expect(failing.reserveUpload({ wallet: null, ipHash: "rollback" }, 1, 3_600)).rejects.toThrow("injected reservation write failure");
    expect(await count("ip:rollback")).toBe(1);
    expect(await createAppStore(second).reserveUpload({ wallet: null, ipHash: "rollback" }, 1, 3_600)).toBe(true);
    expect(await count("ip:rollback")).toBe(1);
  });

  it("backfills only recent legacy usage and migration replay does not charge it twice", async () => {
    assertOwnedDatabase();
    await first.query("INSERT INTO upload (cid, kind, bytes, uploader, ip_hash, created_at) VALUES ($1, 'image', 1, $2, 'legacy-ip', now() - interval '5 minutes'), ($3, 'metadata', 1, NULL, 'anonymous-ip', now() - interval '30 minutes'), ($4, 'image', 1, $2, 'old-ip', now() - interval '2 hours')",
      ["legacy-signed", WALLET.toUpperCase(), "legacy-anonymous", "legacy-expired"]);
    // Reconstruct the pre-0006 database state inside this run's fresh database only.
    await first.query("DROP TABLE memefun_app.upload_reservation");
    await first.query("DELETE FROM memefun_app.schema_migration WHERE id = $1", [MIGRATION]);
    expect(await migrate(first)).toEqual([MIGRATION]);
    expect(await count(`wallet:${WALLET}`)).toBe(1);
    expect(await count("ip:legacy-ip")).toBe(1);
    expect(await count("ip:anonymous-ip")).toBe(1);
    expect(await count("ip:old-ip")).toBe(0);
    expect(await migrate(second)).toEqual([]);
    expect(Number((await first.query("SELECT COUNT(*) AS n FROM upload_reservation")).rows[0].n)).toBe(3);
    expect(await createAppStore(second).reserveUpload({ wallet: WALLET, ipHash: "new-ip" }, 1, 3_600)).toBe(false);
    expect(await createAppStore(first).reserveUpload({ wallet: null, ipHash: "legacy-ip" }, 1, 3_600)).toBe(false);
  });
});
