import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { withJobLock, type KeeperContext } from "../../keeper/context";
import { runJobOnce, type Job } from "../../keeper/registry";
import { createSerialExecutor } from "../../keeper/serial";

const SIGNER = "0x00000000000000000000000000000000000000Aa";
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function barrier() {
  let release!: () => void;
  return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function pool() {
  const held = new Set<string>();
  const keys: string[] = [];
  const releases: boolean[] = [];
  return { keys, releases, held, pool: { connect: async () => {
    const owned = new Set<string>();
    return { query: async (sql: string, [key]: string[]) => {
      keys.push(key!);
      if (sql.includes("pg_try_advisory_lock")) {
        if (held.has(key!)) return { rows: [{ locked: false }] };
        held.add(key!); owned.add(key!);
        return { rows: [{ locked: true }] };
      }
      held.delete(key!); owned.delete(key!);
      return { rows: [] };
    }, release: (discard: boolean) => { releases.push(discard); for (const key of owned) held.delete(key); } };
  } } as unknown as pg.Pool };
}
function context(appPool: pg.Pool) {
  return { appPool, chain: { id: 84532 }, wallets: {
    keeper: { account: { address: SIGNER } }, priceKeeper: { account: { address: SIGNER.toLowerCase() } }, publisher: { account: { address: SIGNER } },
  }, log: vi.fn() } as unknown as KeeperContext;
}

describe("keeper signer serialization", () => {
  it("runs mutating jobs sequentially while metadata remains independent", async () => {
    const f = pool(); const ctx = context(f.pool); const gate = barrier(); const order: string[] = [];
    const job = (name: string, run: () => Promise<unknown>): Job => ({ name, run, everyMs: 1 });
    const first = runJobOnce(ctx, job("buyback", async () => { order.push("buyback start"); await gate.wait; order.push("buyback end"); }));
    const second = runJobOnce(ctx, job("epochs", async () => { order.push("epochs"); }));
    await nextTurn();
    await runJobOnce(ctx, job("metadata", async () => { order.push("metadata"); }));
    expect(order).toEqual(["buyback start", "metadata"]);
    gate.release(); await Promise.all([first, second]);
    expect(order).toEqual(["buyback start", "metadata", "buyback end", "epochs"]);
    expect(f.keys.filter(key => key.startsWith("memefun_keeper_signer:"))).toEqual(Array(4).fill(`memefun_keeper_signer:84532:${SIGNER.toLowerCase()}`));
    expect(f.held.size).toBe(0);
  });

  it("prevents another replica's different job from racing the same signer, then releases it", async () => {
    const f = pool(); const firstCtx = context(f.pool); const secondCtx = context(f.pool); const gate = barrier(); const mutate = vi.fn(async () => 1);
    const first = runJobOnce(firstCtx, { name: "buyback", everyMs: 1, run: async () => { await gate.wait; } });
    await nextTurn();
    await runJobOnce(secondCtx, { name: "floor", everyMs: 1, run: mutate });
    expect(mutate).not.toHaveBeenCalled();
    gate.release(); await first;
    await runJobOnce(secondCtx, { name: "floor", everyMs: 1, run: mutate });
    expect(mutate).toHaveBeenCalledOnce();
    expect(f.held.size).toBe(0);
  });

  it("does not poison the queue after a failure", async () => {
    const serial = createSerialExecutor();
    const failure = serial(async () => { throw new Error("reverted"); });
    const next = serial(async () => "next");
    await expect(failure).rejects.toThrow("reverted");
    await expect(next).resolves.toBe("next");
  });

  it("discards a DB connection if releasing session locks fails", async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => { if (sql.includes("unlock")) throw new Error("connection lost"); return { rows: [{ locked: true }] }; });
    const appPool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
    await expect(withJobLock(appPool, "buyback", async () => 1)).rejects.toThrow("connection lost");
    expect(release).toHaveBeenCalledWith(true);
  });
});
