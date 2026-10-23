import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  ctx: {
    chain: { key: "base" }, dryRun: true, prices: { kind: "none" }, wallets: {}, log: vi.fn(),
    index: { end: vi.fn(async () => undefined) }, appPool: { end: vi.fn(async () => undefined) },
  },
  loadEnv: vi.fn(), createContext: vi.fn(), migrate: vi.fn(), wake: vi.fn(), run: vi.fn(), schedule: vi.fn(),
}));
vi.mock("../../lib/env", () => ({ loadLocalEnv: f.loadEnv }));
vi.mock("../../lib/migrate", () => ({ migrate: f.migrate }));
vi.mock("../../keeper/context", () => ({ createKeeperContext: f.createContext, addressOf: () => undefined, jsonLog: vi.fn() }));
vi.mock("../../keeper/registry", () => ({ JOBS: [{ name: "metadata" }, { name: "buyback" }, { name: "epochs" }], runJobOnce: f.run }));
vi.mock("../../keeper/scheduler", () => ({ startJobs: f.schedule }));
vi.mock("../../keeper/wake", () => ({ waitForIndexer: f.wake }));

import { runKeeper } from "../../keeper/main";

beforeEach(() => {
  vi.resetAllMocks();
  f.createContext.mockReturnValue(f.ctx);
  f.migrate.mockResolvedValue(undefined); f.wake.mockResolvedValue(undefined); f.run.mockResolvedValue(undefined);
  f.ctx.index.end.mockResolvedValue(undefined); f.ctx.appPool.end.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("keeper lifecycle", () => {
  it("runs one pass in order only after the indexer catches up and closes both pools", async () => {
    const order: string[] = [];
    f.wake.mockImplementation(async () => { order.push("ready"); });
    f.run.mockImplementation(async (_ctx, job) => { order.push(job.name); });
    const signalCount = process.listenerCount("SIGTERM");
    await runKeeper(["--once"]);
    expect(order).toEqual(["ready", "metadata", "buyback", "epochs"]);
    expect(f.run).toHaveBeenCalledWith(f.ctx, { name: "buyback" }, { throwOnError: true });
    expect(f.ctx.index.end).toHaveBeenCalledOnce(); expect(f.ctx.appPool.end).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGTERM")).toBe(signalCount);
    expect(f.schedule).not.toHaveBeenCalled();
  });

  it("closes pools after migration failure without running jobs", async () => {
    f.migrate.mockRejectedValue(new Error("database unavailable"));
    await expect(runKeeper(["--once"])).rejects.toThrow("database unavailable");
    expect(f.wake).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    expect(f.ctx.index.end).toHaveBeenCalledOnce(); expect(f.ctx.appPool.end).toHaveBeenCalledOnce();
  });

  it("fails closed and releases resources if the indexer cannot catch up", async () => {
    f.wake.mockRejectedValue(new Error("indexer timeout"));
    await expect(runKeeper(["--once"])).rejects.toThrow("indexer timeout");
    expect(f.run).not.toHaveBeenCalled(); expect(f.schedule).not.toHaveBeenCalled();
    expect(f.ctx.index.end).toHaveBeenCalledOnce(); expect(f.ctx.appPool.end).toHaveBeenCalledOnce();
  });

  it("attempts other jobs after a failed one-shot job, closes resources, then reports failure", async () => {
    f.run.mockRejectedValueOnce(new Error("metadata failed"));
    await expect(runKeeper(["--once"])).rejects.toThrow("Keeper pass failed for: metadata");
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.ctx.index.end).toHaveBeenCalledOnce(); expect(f.ctx.appPool.end).toHaveBeenCalledOnce();
  });

  it("rejects an unknown job before creating wallet or database clients", async () => {
    await expect(runKeeper(["--job", "invalid"])).rejects.toThrow("Unknown job");
    expect(f.createContext).not.toHaveBeenCalled();
  });

  it("waits for scheduled work before closing pools and shares repeated shutdown calls", async () => {
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.fn(() => drained); f.schedule.mockReturnValue(stop);
    const shutdown = (await runKeeper([]))!;
    const first = shutdown(); const second = shutdown();
    expect(first).toBe(second); expect(stop).toHaveBeenCalledOnce();
    expect(f.ctx.index.end).not.toHaveBeenCalled();
    release(); await first;
    expect(f.ctx.index.end).toHaveBeenCalledOnce(); expect(f.ctx.appPool.end).toHaveBeenCalledOnce();
  });
});
