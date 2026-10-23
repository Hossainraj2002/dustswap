import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeeperContext } from "../../keeper/context";
import { waitForIndexer } from "../../keeper/wake";

const context = () => ({ chain: { id: 8453 }, client: { getBlockNumber: vi.fn(async () => 123n) }, log: vi.fn() });
const cast = (ctx: ReturnType<typeof context>) => ctx as unknown as KeeperContext;
const status = (number: number, id = 8453) => Response.json({ memefun: { id, block: { number, timestamp: 1_000 } } });

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("economy keeper indexer wake-up", () => {
  it("does no RPC or HTTP work when wake-up is not configured", async () => {
    vi.stubEnv("MEMEFUN_INDEXER_WAKE_URL", "");
    const ctx = context(); const request = vi.fn();
    await waitForIndexer(cast(ctx), { fetch: request });
    expect(ctx.client.getBlockNumber).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("waits for the captured head, retrying stale and wrong-chain snapshots", async () => {
    const ctx = context(); let clock = 0;
    const request = vi.fn().mockResolvedValueOnce(status(999, 84532)).mockResolvedValueOnce(status(122)).mockResolvedValueOnce(status(124));
    await waitForIndexer(cast(ctx), { url: "https://api.example/status", fetch: request, timeoutMs: 10_000,
      now: () => clock, sleep: async ms => { clock += ms; } });
    expect(ctx.client.getBlockNumber).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { "cache-control": "no-cache" } });
    expect(ctx.log).toHaveBeenLastCalledWith("keeper.indexer-ready", { chain: 8453, targetBlock: "123", indexedBlock: "124", attempts: 3 });
  });

  it("fails closed after network, malformed JSON and HTTP failures exhaust the deadline", async () => {
    const ctx = context(); let clock = 0;
    const request = vi.fn().mockRejectedValueOnce(new Error("secret URL from fetch"))
      .mockResolvedValueOnce(new Response("not json")).mockResolvedValue(new Response("", { status: 503 }));
    await expect(waitForIndexer(cast(ctx), { url: "https://api.example/status", fetch: request, timeoutMs: 5_000,
      now: () => clock, sleep: async ms => { clock += ms; } })).rejects.toThrow("Indexer did not catch up");
    expect(clock).toBe(5_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(ctx.log.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(ctx.log.mock.calls)).not.toContain("api.example");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid status heights (%s)", async number => {
    const ctx = context(); let clock = 0;
    await expect(waitForIndexer(cast(ctx), { url: "https://api.example/status", fetch: vi.fn(async () => status(number)), timeoutMs: 1,
      now: () => clock, sleep: async ms => { clock += ms; } })).rejects.toThrow("did not catch up");
  });

  it.each(["http://public.example/status", "https://user:secret@api.example/status", "https://api.example/status?token=secret", "https://api.example/status#secret", "file:///status"])("rejects unsafe configuration without exposing it (%s)", async url => {
    const ctx = context();
    await expect(waitForIndexer(cast(ctx), { url })).rejects.toThrow("requires HTTPS or private Railway HTTP");
    expect(ctx.client.getBlockNumber).not.toHaveBeenCalled();
  });

  it("allows the Railway private network", async () => {
    const ctx = context(); const request = vi.fn(async () => status(123));
    await waitForIndexer(cast(ctx), { url: "http://memefun-api.railway.internal:8080/status", fetch: request });
    expect(request).toHaveBeenCalledOnce();
  });

  it("bounds a hung chain-head read and hides transport errors", async () => {
    vi.useFakeTimers();
    const ctx = context(); ctx.client.getBlockNumber.mockImplementation(() => new Promise<bigint>(() => {}));
    const request = vi.fn();
    const result = waitForIndexer(cast(ctx), { url: "https://api.example/status", fetch: request, timeoutMs: 1_000 });
    const failed = expect(result).rejects.toThrow("Could not read the chain head");
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
