import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createXStore } from "../../lib/x/store";

const e2e = inject("e2e");
const first = new pg.Pool({ connectionString: e2e.databaseUrl, options: "-c search_path=memefun_app", max: 2 });
const second = new pg.Pool({ connectionString: e2e.databaseUrl, options: "-c search_path=memefun_app", max: 2 });
const a = createXStore(first);
const b = createXStore(second);
const wallet = "0x0000000000000000000000000000000000000001";
const wrongWallet = "0x0000000000000000000000000000000000000002";

afterAll(async () => { await Promise.all([first.end(), second.end()]); });

describe("shared X state in real Postgres", () => {
  it("bounds provider spend across concurrent replicas and opens only the next quota window", async () => {
    const key = `e2e:${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).quota(key, 5, 60, now)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await a.quota(key, 5, 60, now)).toBe(false);
    // A disabled/lower-budget replica during a rolling update must not reset paid usage.
    expect(await b.quota(key, 0, 60, now)).toBe(false);
    expect(await a.quota(key, 5, 60, now)).toBe(false);
    expect(await b.quota(key, 5, 60, now + 60)).toBe(true);
  });

  it("does not consume another wallet's completion and admits one replica only before expiry", async () => {
    const token = randomBytes(32).toString("base64url");
    const author = { id: "44196397", handle: "frog", name: "Frog" };
    await a.putCompletion(token, { wallet, author, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await b.consumeCompletion(token, wrongWallet)).toBeNull();
    expect(await b.completionWallet(token)).toBe(wallet);
    const results = await Promise.all([a.consumeCompletion(token, wallet), b.consumeCompletion(token, wallet)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.author).toEqual(author);
    expect(await a.completionWallet(token)).toBeNull();
    const expired = randomBytes(32).toString("base64url");
    await a.putCompletion(expired, { wallet, author, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(await b.consumeCompletion(expired, wallet)).toBeNull();
    expect(await b.completionWallet(expired)).toBeNull();
  });
});
