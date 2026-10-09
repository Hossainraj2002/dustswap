import { Hono } from "hono";
import { type Address, type Hex, type PublicClient, encodeAbiParameters, encodeEventTopics, getAbiItem, getAddress, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, errorBody } from "../../api/http";
import { platformTokenRoutes } from "../../api/platform-token";
import { createSessions } from "../../api/write/session";
import deploymentRecord from "../../deployments/8453.json";
import type { Queryable } from "../../lib/db";
import { parseDeployment } from "../../lib/deployment";
import { platformTokenConfig } from "../../lib/platform-token/config";
import { createPlatformToken } from "../../lib/platform-token/service";
import { type PlatformIntent, type PlatformLaunch, type PlatformPin, type PlatformTokenStore, createPlatformTokenStore } from "../../lib/platform-token/store";
import { memeFunFactoryAbi } from "../../shared/abis";

const WALLET = getAddress("0x0fd79f3ceae7dda5cfc15b35188e67efac542573");
const COIN = getAddress("0x00000000000000000000000000000000000000aa");
const OTHER = getAddress("0x00000000000000000000000000000000000000bb");
const SALT = `0x${"12".repeat(32)}` as Hex;
const URI = "ipfs://bafy-official-test";
const HASH = `0x${"34".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"56".repeat(32)}` as Hex;
const deployment = parseDeployment(deploymentRecord, 8453);
const config = { launchAt: "2026-10-11T09:00:00.000Z", launcher: WALLET };
const initial: PlatformIntent = { coin: COIN, launcher: WALLET, salt: SALT, contractURI: URI, afterBlock: 99n, createdAt: "2026-10-11T09:00:00.000Z" };
const candidate: PlatformLaunch = { coin: COIN, launcher: WALLET, contractURI: URI, launchBlock: 100n, logIndex: 7, txHash: HASH };
const checkpoint = (chain: number, block: bigint, full = true) => `1780000000${String(chain).padStart(16, "0")}${block.toString().padStart(16, "0")}${(full ? "9" : "0").repeat(33)}`;

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T09:00:10Z"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const event = getAbiItem({ abi: memeFunFactoryAbi, name: "Launched" });
  const record = { poolId: HASH, mode: 0, module: zeroAddress, feeBps: 100n, platformShareBps: 1000n, referralShareBps: 1000n,
    creatorKeepBps: 0n, protectionStartBps: 0n, protectionDurationSec: 0n, startTick: 0, liquidity: 1n,
    quoteUsdE8: 1n, openingFdvUsdE8: 1n, firstBuyQuote: 0n, firstBuyCoins: 0n };
  const log = { address: deployment.factory, logIndex: 7, data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), ["Official", "OFF", URI, record]),
    topics: encodeEventTopics({ abi: memeFunFactoryAbi, eventName: "Launched", args: { coin: COIN, creator: WALLET, quote: zeroAddress } }) };
  const receipt = { status: "success", blockNumber: 100n, blockHash: BLOCK_HASH, logs: [log] };
  const getChainId = vi.fn(async () => 8453);
  const getBlock = vi.fn(async (args?: { blockNumber?: bigint }) => ({ number: args?.blockNumber ?? 102n, hash: BLOCK_HASH, timestamp: 1791709210n }));
  const readContract = vi.fn(async () => COIN);
  const getCode = vi.fn(async (): Promise<Hex | undefined> => undefined);
  const getTransactionReceipt = vi.fn(async () => receipt);
  const client = { getChainId, getBlock, readContract, getCode, getTransactionReceipt } as unknown as PublicClient;
  const store = {
    pin: vi.fn(async (): Promise<PlatformPin | null> => null), intent: vi.fn(async (): Promise<PlatformIntent | null> => null),
    prepare: vi.fn(async () => ({ state: "created" as const, intent: initial })), ready: vi.fn(async () => true),
    candidate: vi.fn(async (): Promise<PlatformLaunch | null> => candidate), register: vi.fn(async (scope: unknown, pin: PlatformPin) => pin),
    quota: vi.fn(async () => true), prune: vi.fn(async () => undefined),
  };
  return { client, store, receipt, log, getChainId, getBlock, readContract, getCode, getTransactionReceipt,
    service: createPlatformToken(config, client, deployment, store as unknown as PlatformTokenStore) };
}

describe("optional official token configuration", () => {
  it("requires both public settings on Base and accepts an exact UTC instant", () => {
    expect(platformTokenConfig(8453)).toBeNull();
    vi.stubEnv("MEMEFUN_PLATFORM_TOKEN_LAUNCH_AT", "2026-10-11T09:00:00Z");
    expect(platformTokenConfig(8453)).toBeNull();
    vi.stubEnv("MEMEFUN_PLATFORM_TOKEN_LAUNCHER", WALLET);
    expect(platformTokenConfig(8453)).toEqual(config);
    expect(platformTokenConfig(84532)).toBeNull();
  });
  it.each(["tomorrow", "2026-02-30T09:00:00Z", "2026-10-11", "2026-10-11T09:00:00+00:00"])("disables malformed launch time %s", value => {
    vi.stubEnv("MEMEFUN_PLATFORM_TOKEN_LAUNCHER", WALLET); vi.stubEnv("MEMEFUN_PLATFORM_TOKEN_LAUNCH_AT", value);
    expect(platformTokenConfig(8453)).toBeNull();
  });
  it.each(["not-an-address", zeroAddress])("disables invalid launcher %s", value => {
    vi.stubEnv("MEMEFUN_PLATFORM_TOKEN_LAUNCHER", value); vi.stubEnv("MEMEFUN_PLATFORM_TOKEN_LAUNCH_AT", "2026-10-11T09:00:00Z");
    expect(platformTokenConfig(8453)).toBeNull();
  });
});

describe("authenticated fresh official launch preparation", () => {
  it("has no RPC or database dependency when disabled", async () => {
    const f = fixture();
    const service = createPlatformToken(null, f.client, deployment, f.store as unknown as PlatformTokenStore);
    expect(await service.summary()).toEqual({ enabled: false });
    await expect(service.prepare(WALLET, SALT, URI)).rejects.toMatchObject({ code: "platform_token_unavailable" });
    expect(f.getChainId).not.toHaveBeenCalled(); expect(f.store.pin).not.toHaveBeenCalled();
  });
  it("rejects another wallet before prediction or database writes", async () => {
    const f = fixture();
    await expect(f.service.prepare(OTHER, SALT, URI)).rejects.toMatchObject({ status: 403, code: "platform_token_launcher" });
    expect(f.readContract).not.toHaveBeenCalled(); expect(f.store.prepare).not.toHaveBeenCalled();
  });
  it("binds exact metadata, predicted coin and observed head before the factory transaction", async () => {
    const f = fixture();
    expect(await f.service.prepare(WALLET, SALT, URI)).toMatchObject({ coin: COIN, salt: SALT, contractURI: URI, created: true });
    expect(f.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: deployment.factory, functionName: "predictCoin", args: [WALLET, SALT], blockNumber: 102n }));
    expect(f.getCode).toHaveBeenCalledWith({ address: COIN, blockTag: "latest" });
    expect(f.store.prepare).toHaveBeenCalledWith({ chainId: 8453, factory: deployment.factory }, expect.objectContaining({ coin: COIN, launcher: WALLET, contractURI: URI, afterBlock: 102n }));
  });
  it("rejects retroactive nomination of an already deployed token", async () => {
    const f = fixture(); f.getCode.mockResolvedValue("0x1234");
    await expect(f.service.prepare(WALLET, SALT, URI)).rejects.toMatchObject({ status: 409, code: "platform_token_exists" });
    expect(f.store.prepare).not.toHaveBeenCalled();
  });
  it("preserves an exact retry after creation without a short wallet-prompt TTL", async () => {
    const f = fixture(); f.store.intent.mockResolvedValue(initial); f.getCode.mockResolvedValue("0x1234");
    vi.setSystemTime("2026-10-11T10:00:00Z");
    expect(await f.service.prepare(WALLET, SALT, URI)).toMatchObject({ coin: COIN, created: false, createdAt: initial.createdAt });
    expect(f.getCode).not.toHaveBeenCalled(); expect(f.store.prepare).not.toHaveBeenCalled();
  });
  it("rejects changed metadata and prevents a second official token", async () => {
    const f = fixture(); f.store.intent.mockResolvedValue(initial);
    await expect(f.service.prepare(WALLET, SALT, `${URI}-changed`)).rejects.toMatchObject({ code: "platform_token_intent_conflict" });
    f.store.intent.mockResolvedValue(null); f.store.pin.mockResolvedValue({ ...candidate, blockHash: BLOCK_HASH });
    await expect(f.service.prepare(WALLET, SALT, URI)).rejects.toMatchObject({ code: "platform_token_pinned" });
    expect(f.store.prepare).not.toHaveBeenCalled();
  });
  it("allows exact prepare retry for the pinned token", async () => {
    const f = fixture(); f.store.intent.mockResolvedValue(initial); f.store.pin.mockResolvedValue({ ...candidate, blockHash: BLOCK_HASH });
    expect(await f.service.prepare(WALLET, SALT, URI)).toMatchObject({ coin: COIN, created: false });
  });
  it("fails closed on wrong RPC chain and sanitizes infrastructure errors", async () => {
    const f = fixture(); f.getChainId.mockResolvedValue(84532);
    await expect(f.service.prepare(WALLET, SALT, URI)).rejects.toMatchObject({ code: "platform_token_unavailable" });
    expect(f.readContract).not.toHaveBeenCalled();
    f.getChainId.mockRejectedValue(new Error("private RPC credentials"));
    await expect(f.service.prepare(WALLET, SALT, URI)).rejects.toMatchObject({ message: "Official token information is unavailable. Try again later." });
  });
});

describe("canonical official token resolution", () => {
  it("recovers a prepared launch through GET and validates the actual factory event", async () => {
    const f = fixture();
    expect(await f.service.summary()).toEqual({ enabled: true, ...config, tokenAddress: COIN });
    expect(f.store.ready).toHaveBeenCalledWith(8453, 100n);
    expect(f.store.candidate).toHaveBeenCalledWith({ chainId: 8453, factory: deployment.factory }, 100n, WALLET);
    expect(f.store.register).toHaveBeenCalledWith(expect.anything(), { ...candidate, blockHash: BLOCK_HASH });
  });
  it("requires three confirmations and a whole indexed boundary block", async () => {
    const f = fixture(); f.getBlock.mockResolvedValue({ number: 101n, hash: BLOCK_HASH, timestamp: 1n });
    expect(await f.service.summary()).toMatchObject({ tokenAddress: null });
    expect(f.store.register).not.toHaveBeenCalled();
    const lag = fixture(); lag.store.ready.mockResolvedValue(false);
    expect(await lag.service.summary()).toMatchObject({ tokenAddress: null }); expect(lag.store.candidate).not.toHaveBeenCalled();
  });
  it.each(["wrong-factory", "wrong-creator", "wrong-coin", "wrong-uri", "wrong-log", "reverted", "reorg"])("never pins %s evidence", async problem => {
    const f = fixture();
    if (problem === "wrong-factory") f.log.address = OTHER;
    if (problem === "wrong-creator") f.log.topics = encodeEventTopics({ abi: memeFunFactoryAbi, eventName: "Launched", args: { coin: COIN, creator: OTHER, quote: zeroAddress } });
    if (problem === "wrong-coin") f.store.candidate.mockResolvedValue({ ...candidate, coin: OTHER });
    if (problem === "wrong-uri") f.store.candidate.mockResolvedValue({ ...candidate, contractURI: `${URI}-changed` });
    if (problem === "wrong-log") f.log.logIndex = 8;
    if (problem === "reverted") f.receipt.status = "reverted";
    if (problem === "reorg") f.receipt.blockHash = HASH;
    expect(await f.service.summary()).toMatchObject({ tokenAddress: null }); expect(f.store.register).not.toHaveBeenCalled();
  });
  it("does not use the mutable creator, token ticker or transaction sender as authorization", async () => {
    const f = fixture();
    // Only the authenticated configured launcher and the emitted factory creator matter.
    expect(await f.service.summary()).toMatchObject({ tokenAddress: COIN });
    expect(f.getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });
  it("retains the existing immutable pin when it disappears and never selects a replacement", async () => {
    const f = fixture(); f.store.pin.mockResolvedValue({ ...candidate, blockHash: HASH });
    expect(await f.service.summary()).toMatchObject({ tokenAddress: null });
    expect(f.store.candidate).not.toHaveBeenCalled(); expect(f.store.register).not.toHaveBeenCalled();
  });
  it("honors another replica's winning pin only after independently verifying it", async () => {
    const f = fixture(); f.store.register.mockResolvedValue({ ...candidate, coin: OTHER, blockHash: BLOCK_HASH });
    expect(await f.service.summary()).toMatchObject({ tokenAddress: null });
    expect(f.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });
  it("coalesces public polls and only caches canonical status for five seconds", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 10 }, () => f.service.summary()));
    expect(f.getChainId).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5_001); await f.service.summary();
    expect(f.getChainId).toHaveBeenCalledTimes(2);
  });
  it("does not return stale official status after a failed canonical reread", async () => {
    const f = fixture(); await f.service.summary();
    vi.setSystemTime(Date.now() + 5_001); f.getTransactionReceipt.mockRejectedValue(new Error("private URL"));
    await expect(f.service.summary()).rejects.toMatchObject({ code: "platform_token_unavailable" });
  });
});

describe("official token HTTP authorization and quota", () => {
  function appFixture() {
    const f = fixture(); const sessions = createSessions("unit-test-only-session-secret-123456789");
    const app = new Hono(); app.onError((error, c) => error instanceof HttpError ? c.json(errorBody(error), error.status) : c.json({ error: "unexpected" }, 500));
    app.route("/", platformTokenRoutes({ platformToken: f.service, sessions, ipSalt: "public-unit-test-salt" }));
    const post = (wallet?: Address, body: unknown = { salt: SALT, contractURI: URI }) => app.request("/v1/platform-token/prepare", {
      method: "POST", headers: { "content-type": "application/json", ...(wallet ? { authorization: `Bearer ${sessions.issue(wallet).token}` } : {}) }, body: JSON.stringify(body),
    });
    return { ...f, app, post };
  }
  it("returns disabled information without optional dependencies", async () => {
    const app = new Hono(); app.route("/", platformTokenRoutes());
    expect(await (await app.request("/v1/platform-token")).json()).toEqual({ enabled: false });
  });
  it("requires a valid session and designated launcher", async () => {
    const f = appFixture(); expect((await f.post()).status).toBe(401); expect((await f.post(OTHER)).status).toBe(403);
    expect(f.store.prepare).not.toHaveBeenCalled();
  });
  it("returns the exact prepared fields and status, without accepting a claimed wallet", async () => {
    const f = appFixture(); const response = await f.post(WALLET);
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ coin: COIN, salt: SALT, contractURI: URI, createdAt: initial.createdAt });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await f.post(WALLET, { salt: SALT, contractURI: URI, launcher: OTHER })).status).toBe(400);
  });
  it.each([{ salt: "0x1234", contractURI: URI }, { salt: SALT, contractURI: "javascript:bad" }, { salt: SALT, contractURI: `${URI}\n` }])("rejects malformed intent %j", async body => {
    const f = appFixture(); expect((await f.post(WALLET, body)).status).toBe(400); expect(f.store.prepare).not.toHaveBeenCalled();
  });
  it("charges shared wallet/IP budgets and fails before prediction when exhausted", async () => {
    const f = appFixture(); f.store.quota.mockResolvedValue(false);
    const response = await f.post(WALLET); expect(response.status).toBe(429); expect(f.readContract).not.toHaveBeenCalled();
  });
});

describe("official selector complete-block readiness", () => {
  it.each([
    [[], false],
    [[{ chain_id: "8453", latest_checkpoint: checkpoint(8453, 100n) }], true],
    [[{ chain_id: 8453, latest_checkpoint: checkpoint(8453, 100n, false) }], false],
    [[{ chain_id: 8453, latest_checkpoint: checkpoint(8453, 99n) }], false],
    [[{ chain_id: 84532, latest_checkpoint: checkpoint(84532, 101n) }], false],
    [[{ chain_id: 8453, latest_checkpoint: checkpoint(8453, 101n) }, { chain_id: 84532, latest_checkpoint: checkpoint(84532, 101n) }], false],
  ])("checks exact single-chain coverage %#", async (values, expected) => {
    const index = { query: vi.fn(async () => ({ rows: values })) } as unknown as Queryable;
    const store = createPlatformTokenStore(index, {} as Parameters<typeof createPlatformTokenStore>[1]);
    expect(await store.ready(8453, 100n)).toBe(expected);
  });
});
