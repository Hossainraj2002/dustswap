import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../keeper/registry";
import { startJobs } from "../../keeper/scheduler";

const job = (name: string, everyMs = 1_000): Job => ({ name, everyMs, run: async () => undefined });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("keeper scheduling", () => {
  it("runs immediately and retains only one pending timer per job after many cycles", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const run = vi.fn(async () => undefined);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const stop = startJobs([job("metadata"), job("buyback")], run);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(run).toHaveBeenCalledTimes(202);
    expect(vi.getTimerCount()).toBe(2);
    stop();
    // Fired handles are released, so shutdown clears only the two live timers.
    expect(clear).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(202);
    stop();
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("waits for a job to finish before starting its next interval and preserves jitter", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const stop = startJobs([job("epochs")], run);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
