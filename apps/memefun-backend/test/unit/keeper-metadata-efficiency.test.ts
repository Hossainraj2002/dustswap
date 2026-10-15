import { describe, expect, it, vi } from "vitest";
import type { KeeperContext } from "../../keeper/context";
import { runMetadata } from "../../keeper/jobs/metadata";
import { createAppStore } from "../../lib/app-store";
import { cidV1Raw } from "../../lib/cid";
import { BucketMediaStore } from "../../lib/media/bucket";

const COIN = "0x0000000000000000000000000000000000000001";
const SECOND = "0x0000000000000000000000000000000000000002";
const URI = `data:application/json,${encodeURIComponent(JSON.stringify({ description: "Original description" }))}`;

function fixture(options: {
  discoveries?: Array<{ address: string; contract_uri: string }>;
  due?: Array<{ coin: string; contract_uri: string; attempts: number }>;
} = {}) {
  const index = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("NOT EXISTS")
    ? options.discoveries ?? []
    : [{ address: COIN, name: "Original name", symbol: "ORIGINAL" }] })) };
  const app = {
    knownCoinMetadata: vi.fn(), enqueueCoinMetadata: vi.fn(),
    enqueueCoinMetadataBatch: vi.fn(async () => undefined),
    dueCoinMetadata: vi.fn(async () => options.due ?? []),
    metadataByCids: vi.fn(async () => new Map()),
    resolveCoinMetadata: vi.fn(async () => undefined),
    saveMetadata: vi.fn(async () => undefined),
  };
  const media = new BucketMediaStore({ get: async () => null, put: async () => undefined }, "https://media.memefun.test");
  const ctx = { index, app, media, log: vi.fn() } as unknown as KeeperContext;
  return { ctx, index, app, media };
}

describe("bounded keeper metadata work", () => {
  it("does not download historical metadata keys or coin names when no work is due", async () => {
    const f = fixture();
    await expect(runMetadata(f.ctx)).resolves.toEqual({ resolved: 0, failed: 0 });
    expect(f.index.query).toHaveBeenCalledOnce();
    expect(f.index.query).toHaveBeenCalledWith(expect.stringContaining("memefun_app.coin_metadata"), [100]);
    expect(f.app.knownCoinMetadata).not.toHaveBeenCalled();
    expect(f.app.enqueueCoinMetadata).not.toHaveBeenCalled();
    expect(f.app.enqueueCoinMetadataBatch).not.toHaveBeenCalled();
    expect(f.app.dueCoinMetadata).toHaveBeenCalledWith(20);
  });

  it("awaits one batched enqueue before selecting due work", async () => {
    const f = fixture({ discoveries: [{ address: COIN, contract_uri: URI }, { address: SECOND, contract_uri: "data:application/json,{}" }] });
    let queued = false;
    f.app.enqueueCoinMetadataBatch.mockImplementation(async () => { await Promise.resolve(); queued = true; });
    f.app.dueCoinMetadata.mockImplementation(async () => { expect(queued).toBe(true); return []; });
    await runMetadata(f.ctx);
    expect(f.app.enqueueCoinMetadataBatch).toHaveBeenCalledExactlyOnceWith([
      { coin: COIN, contractUri: URI }, { coin: SECOND, contractUri: "data:application/json,{}" },
    ]);
    expect(f.index.query).toHaveBeenCalledOnce();
  });

  it("loads names only for due addresses and preserves imported metadata", async () => {
    const f = fixture({ due: [{ coin: COIN, contract_uri: URI, attempts: 0 }] });
    await expect(runMetadata(f.ctx)).resolves.toEqual({ resolved: 1, failed: 0 });
    expect(f.index.query).toHaveBeenNthCalledWith(2, expect.stringContaining("address = ANY($1::text[])"), [[COIN]]);
    expect(f.app.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      name: "Original name", symbol: "ORIGINAL", description: "Original description", source: "fetched",
    }));
    expect(f.app.resolveCoinMetadata).toHaveBeenCalledWith(COIN, "resolved", expect.objectContaining({ cid: expect.any(String) }));
  });

  it.each([{ attempts: 2, status: "failed", delay: 1_800 }, { attempts: 7, status: "unsupported", delay: 86_400 }])(
    "preserves retry limits and backoff for attempt $attempts", async ({ attempts, status, delay }) => {
      const cid = cidV1Raw(new TextEncoder().encode("missing"));
      const f = fixture({ due: [{ coin: COIN, contract_uri: `ipfs://${cid}`, attempts }] });
      await expect(runMetadata(f.ctx)).resolves.toEqual({ resolved: 0, failed: 1 });
      expect(f.app.resolveCoinMetadata).toHaveBeenCalledWith(COIN, status, { error: "not found on IPFS", retryInSec: delay });
    },
  );

  it("does not process a batch after its enqueue failed; the next run can retry discovery", async () => {
    const f = fixture({ discoveries: [{ address: COIN, contract_uri: URI }] });
    f.app.enqueueCoinMetadataBatch.mockRejectedValueOnce(new Error("temporary DB outage"));
    await expect(runMetadata(f.ctx)).rejects.toThrow("temporary DB outage");
    expect(f.app.dueCoinMetadata).not.toHaveBeenCalled();
    await expect(runMetadata(f.ctx)).resolves.toEqual({ resolved: 0, failed: 0 });
    expect(f.app.enqueueCoinMetadataBatch).toHaveBeenCalledTimes(2);
  });
});

describe("metadata batch persistence", () => {
  it("binds paired address/URI arrays in one idempotent statement and skips empty batches", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createAppStore({ query, connect: vi.fn() } as unknown as Parameters<typeof createAppStore>[0]);
    await app.enqueueCoinMetadataBatch([]);
    expect(query).not.toHaveBeenCalled();
    await app.enqueueCoinMetadataBatch([{ coin: COIN, contractUri: URI }, { coin: SECOND, contractUri: "other" }]);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("ON CONFLICT (coin) DO NOTHING"), [[COIN, SECOND], [URI, "other"]]);
  });
});
