import { afterEach, describe, expect, it, vi } from "vitest";

import { chainRpcTransport, chainSettings } from "../../lib/chain";
import { createRpcPacer } from "../../lib/rpc-pacing";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("public RPC pacing", () => {
  it("spaces queued starts by 200ms, limits concurrency to two, and clears its timers", async () => {
    vi.useFakeTimers();
    const pacer = createRpcPacer();
    const starts: number[] = [];
    let active = 0;
    let maximum = 0;
    const work = Array.from({ length: 8 }, async () => {
      const release = await pacer.acquire();
      starts.push(performance.now());
      active += 1;
      maximum = Math.max(maximum, active);
      try { await sleep(350); }
      finally { active -= 1; release(); }
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all(work);
    expect(starts).toEqual([0, 200, 400, 600, 800, 1_000, 1_200, 1_400]);
    expect(maximum).toBe(2);
    expect(pacer.active).toBe(0);
    expect(pacer.pending).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a queued cached failure without consuming the next HTTP slot", async () => {
    vi.useFakeTimers();
    const pacer = createRpcPacer();
    const first = await pacer.acquire();
    let blocked = false;
    const failure = new Error("Provider entered cooldown.");
    const waiting = pacer.acquire(() => { if (blocked) throw failure; }).catch(error => error);
    blocked = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(await waiting).toBe(failure);
    const next = await pacer.acquire();
    expect(performance.now()).toBe(200);
    expect(pacer.active).toBe(2);
    next(); first();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds queue waits and releases timed-out waiters", async () => {
    vi.useFakeTimers();
    const pacer = createRpcPacer({ maxWaitMs: 500 });
    const first = await pacer.acquire();
    const secondWaiting = pacer.acquire();
    await vi.advanceTimersByTimeAsync(200);
    const second = await secondWaiting;
    const outcome = pacer.acquire().catch(error => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(await outcome).toMatchObject({ name: "TimeoutError" });
    expect(pacer.pending).toBe(0);
    first(); second();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps separate public URLs independent", async () => {
    vi.useFakeTimers();
    const firstUrl = createRpcPacer();
    const secondUrl = createRpcPacer();
    const first = await firstUrl.acquire();
    const queued = firstUrl.acquire();
    const independent = await secondUrl.acquire();
    expect(performance.now()).toBe(0);
    independent(); first();
    await vi.advanceTimersByTimeAsync(200);
    (await queued)();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("persists pacing across viem factories and methods while wall time is frozen", async () => {
    vi.useFakeTimers();
    const wallTime = Date.parse("2026-11-07T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(wallTime);
    process.env.MEMEFUN_CHAIN = "base";
    const starts: number[] = [];
    let active = 0;
    let maximum = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      starts.push(performance.now());
      active += 1;
      maximum = Math.max(maximum, active);
      await sleep(350);
      active -= 1;
      return Response.json({ result: "0x123" });
    }));
    const chain = { ...chainSettings(), rpcUrls: ["https://public.test"] };
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    const work = Array.from({ length: 6 }, (_, i) => i % 2
      ? transport.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", `0x${i.toString(16)}`] })
      : transport.request({ method: "eth_blockNumber" }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await Promise.all(work)).toEqual(Array(6).fill("0x123"));
    expect(starts).toEqual([0, 200, 400, 600, 800, 1_000]);
    expect(maximum).toBe(2);
    expect(Date.now()).toBe(wallTime);
  });

  it("releases its HTTP permit after an authoritative RPC error", async () => {
    vi.useFakeTimers();
    process.env.MEMEFUN_CHAIN = "base";
    const starts: number[] = [];
    const fetch = vi.fn(async () => {
      starts.push(performance.now());
      return starts.length === 1 ? Response.json({ error: { code: 3, message: "execution reverted" } })
        : Response.json({ result: "0x123" });
    });
    vi.stubGlobal("fetch", fetch);
    const chain = { ...chainSettings(), rpcUrls: ["https://public.test"] };
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    const rejected = expect(transport.request({ method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001" }, "latest"] })).rejects.toMatchObject({ details: "execution reverted" });
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    const recovered = transport.request({ method: "eth_blockNumber" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await recovered).toBe("0x123");
    expect(starts).toEqual([0, 200]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
