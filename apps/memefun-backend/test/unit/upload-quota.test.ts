import { Hono } from "hono";
import { HonoRequest } from "hono/request";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, errorBody, hashIp } from "../../api/http";
import { writeRoutes } from "../../api/write/routes";
import { createSessions } from "../../api/write/session";
import type { MarketSnapshot } from "../../api/read/snapshot";
import type { AppStore } from "../../lib/app-store";
import { cidV1Raw } from "../../lib/cid";
import { ImageRejected, processCoinImage } from "../../lib/media/image";
import type * as ImageModule from "../../lib/media/image";
import type { MediaStore } from "../../lib/media/store";

vi.mock("../../lib/media/image", async (original) => {
  const actual = await original<typeof ImageModule>();
  return { ...actual, processCoinImage: vi.fn() };
});

const WALLET = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const IP = "192.0.2.1";
const SALT = "upload-quota-unit-test";
const WEBP = new Uint8Array([1, 2, 3]);
const IMAGE_CID = cidV1Raw(WEBP);
const sessions = createSessions("upload-quota-test-secret".repeat(2));
let now: number;

beforeEach(() => {
  vi.clearAllMocks();
  now = Date.UTC(2026, 9, 6);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(processCoinImage).mockResolvedValue({ webp: WEBP, sourceType: "image/png" });
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const attempts = new Map<string, number>();
  const uploads = new Set<string>();
  const reserveUpload = vi.fn(async (by: { wallet: string | null; ipHash: string }, limit: number) => {
    const key = by.wallet ? `wallet:${by.wallet}` : `ip:${by.ipHash}`;
    if ((attempts.get(key) ?? 0) >= limit) return false;
    for (const principal of new Set([key, `ip:${by.ipHash}`])) attempts.set(principal, (attempts.get(principal) ?? 0) + 1);
    return true;
  });
  const store = { reserveUpload,
    hasUpload: vi.fn(async () => true),
    recordUpload: vi.fn(async ({ cid }: { cid: string }) => { uploads.add(cid); }),
    saveMetadata: vi.fn(async () => undefined) };
  const put = vi.fn(async (bytes: Uint8Array, contentType: string) => {
    const cid = cidV1Raw(bytes);
    return { cid, uri: `ipfs://${cid}`, url: `https://media.test/${cid}`, bytes: bytes.length, contentType };
  });
  const media = { kind: "local", put } as unknown as MediaStore;
  const app = new Hono();
  app.onError((error, c) => error instanceof HttpError ? c.json(errorBody(error), error.status) : c.json({ error: { code: "internal" } }, 500));
  app.route("/", writeRoutes({ chainId: 8453, app: store as unknown as AppStore, media, snapshot: {} as MarketSnapshot, sessions, ipSalt: SALT }));
  const request = (kind: "image" | "metadata", options: { wallet?: string; ip?: string; body?: string } = {}) => {
    // Separate burst windows without leaving the rolling hour tested here.
    now += 6_100;
    return app.request(`/v1/media/${kind}`, { method: "POST", headers: {
      "x-forwarded-for": options.ip ?? IP,
      "content-type": kind === "image" ? "image/png" : "application/json",
      ...(options.wallet ? { authorization: `Bearer ${sessions.issue(options.wallet).token}` } : {}),
    }, body: options.body ?? (kind === "image" ? "same image bytes" : JSON.stringify({ name: "Frog", symbol: "FROG", image: `ipfs://${IMAGE_CID}` })) });
  };
  return { app, attempts, uploads, store, put, request };
}

describe("upload attempt quotas at the HTTP boundary", () => {
  it.each(["image", "metadata"] as const)("charges identical %s CIDs once per attempt rather than once per stored object", async kind => {
    const f = fixture();
    for (let i = 0; i < 20; i += 1) expect((await f.request(kind)).status).toBe(201);
    expect(f.uploads.size).toBe(1);
    const response = await f.request(kind);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "upload_quota" } });
    expect(f.put).toHaveBeenCalledTimes(20);
    expect(f.store.recordUpload).toHaveBeenCalledTimes(20);
    expect(f.store.reserveUpload).toHaveBeenLastCalledWith({ wallet: null, ipHash: hashIp(IP, SALT) }, 20, 3_600);
  });

  it("shares the hourly budget between image and metadata routes", async () => {
    const f = fixture();
    for (let i = 0; i < 10; i += 1) {
      expect((await f.request("image")).status).toBe(201);
      expect((await f.request("metadata")).status).toBe(201);
    }
    expect((await f.request("metadata")).status).toBe(429);
    expect(f.put).toHaveBeenCalledTimes(20);
  });

  it("uses the signed wallet limit across IPs, preserves other wallets and charges anonymous network usage", async () => {
    const f = fixture();
    for (let i = 0; i < 60; i += 1) expect((await f.request("image", { wallet: WALLET, ip: i % 2 ? IP : "192.0.2.2" })).status).toBe(201);
    expect((await f.request("image", { wallet: WALLET, ip: "192.0.2.3" })).status).toBe(429);
    expect((await f.request("image", { wallet: OTHER })).status).toBe(201);
    expect((await f.request("image")).status).toBe(429);
    expect((await f.request("image", { ip: "192.0.2.4" })).status).toBe(201);
    expect(f.store.reserveUpload).toHaveBeenCalledWith({ wallet: WALLET.toLowerCase(), ipHash: hashIp(IP, SALT) }, 60, 3_600);
    expect(f.store.reserveUpload).toHaveBeenCalledWith({ wallet: OTHER.toLowerCase(), ipHash: hashIp(IP, SALT) }, 60, 3_600);
  });

  it.each(["image", "metadata"] as const)("charges rejected %s requests and stops processing once exhausted", async kind => {
    const f = fixture();
    vi.mocked(processCoinImage).mockRejectedValue(new ImageRejected("invalid test image"));
    for (let i = 0; i < 20; i += 1) expect((await f.request(kind, { body: "{" })).status).toBe(kind === "image" ? 422 : 400);
    const processed = vi.mocked(processCoinImage).mock.calls.length;
    const parse = vi.spyOn(HonoRequest.prototype, "json");
    expect((await f.request(kind, { body: "{" })).status).toBe(429);
    expect(processCoinImage).toHaveBeenCalledTimes(processed);
    expect(parse).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
    expect(f.store.recordUpload).not.toHaveBeenCalled();
    expect(f.store.reserveUpload).toHaveBeenCalledTimes(21);
  });

  it.each(["image", "metadata"] as const)("fails closed before parsing or image processing when %s quota storage is unavailable", async kind => {
    const f = fixture();
    f.store.reserveUpload.mockRejectedValue(new Error("database unavailable"));
    const parse = vi.spyOn(HonoRequest.prototype, "json");
    expect((await f.request(kind, { body: "{" })).status).toBe(500);
    expect(parse).not.toHaveBeenCalled();
    expect(processCoinImage).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
    expect(f.store.recordUpload).not.toHaveBeenCalled();
  });
});
