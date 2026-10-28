import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";
import { base } from "viem/chains";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ALCHEMY_API_KEY", "fallback-key");
  vi.stubEnv("NEXT_PUBLIC_ALCHEMY_BASE_RPC_KEYS", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_RPC_URLS", "https://base-mainnet.alchemyapi.io/v2/explicit-key");
  vi.stubEnv("NEXT_PUBLIC_BASE_RPC_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_SEPOLIA_RPC_URLS", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL", "");
  vi.stubEnv("NEXT_PUBLIC_MEMEFUN_LOCAL_RPC_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("public-first wallet RPC", () => {
  it("supplies public defaults before configured Alchemy URLs and keys", async () => {
    const { getRpcUrlsForChain } = await import("./rpc");
    expect(getRpcUrlsForChain(8453)).toEqual([
      "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base.gateway.tenderly.co",
      "https://base-mainnet.alchemyapi.io/v2/explicit-key", "https://base-mainnet.g.alchemy.com/v2/fallback-key",
    ]);
    expect(getRpcUrlsForChain(84532)[0]).toBe("https://sepolia.base.org");
  });

  it("filters malformed and non-HTTP configuration before creating the real viem request", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_RPC_URLS", "bad url, wss://websocket.example, file:///rpc, HTTPS://MAINNET.BASE.ORG:443/?, https://mainnet.base.org/#unused, https://base-mainnet.g.alchemy.com/v2/key");
    vi.stubEnv("NEXT_PUBLIC_BASE_SEPOLIA_RPC_URLS", "bad url");
    vi.stubEnv("NEXT_PUBLIC_MEMEFUN_LOCAL_RPC_URL", "bad url");
    const { createRpcTransport, getRpcUrlsForChain } = await import("./rpc");
    const urls = getRpcUrlsForChain(8453);
    expect(urls).toEqual([
      "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base.gateway.tenderly.co",
      "https://base-mainnet.g.alchemy.com/v2/key", "https://base-mainnet.g.alchemy.com/v2/fallback-key",
    ]);
    expect(getRpcUrlsForChain(84532)[0]).toBe("https://sepolia.base.org");
    expect(getRpcUrlsForChain(31337)).toEqual(["http://127.0.0.1:8545"]);
    const fetch = vi.fn(async (_url: string | URL | Request) => Response.json({ result: "0x2105" }));
    vi.stubGlobal("fetch", fetch);
    const client = createPublicClient({ chain: base, transport: createRpcTransport(["bad url", "wss://websocket.example", ...urls]) });
    expect(await client.getChainId()).toBe(8453);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("alchemy");
  });

  it("preserves a valid local RPC override", async () => {
    vi.stubEnv("NEXT_PUBLIC_MEMEFUN_LOCAL_RPC_URL", " http://localhost:9545/ ");
    const { getRpcUrlsForChain } = await import("./rpc");
    expect(getRpcUrlsForChain(31337)).toEqual(["http://localhost:9545"]);
  });

  it("keeps Alchemy out of normal traffic across rotation cycles", async () => {
    const { getRpcUrlsForChain, rotatingFetch } = await import("./rpc");
    const fetch = vi.fn(async (_url: string) => Response.json({ result: "0x1" }));
    vi.stubGlobal("fetch", fetch);
    const rpc = rotatingFetch(getRpcUrlsForChain(8453));
    for (let i = 0; i < 320; i += 1) await rpc("https://unused.example", { method: "POST" });
    expect(new Set(fetch.mock.calls.map(([url]) => url))).toEqual(new Set(["https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base.gateway.tenderly.co"]));
  });

  it("exhausts public failures before reaching Alchemy and preserves the response body", async () => {
    const { rotatingFetch } = await import("./rpc");
    const urls = ["https://public-one.example", "https://public-two.example", "https://base-mainnet.g.alchemy.com/v2/key"];
    const fetch = vi.fn(async (url: string) => url.includes("alchemy")
      ? Response.json({ result: "0x1" })
      : Response.json({ error: { code: -32005, message: "rate limit exceeded" } }));
    vi.stubGlobal("fetch", fetch);
    const response = await rotatingFetch(urls)(urls[0] as string);
    expect(await response.json()).toEqual({ result: "0x1" });
    expect(fetch.mock.calls.map(([url]) => url).slice(0, 2)).toEqual(expect.arrayContaining(urls.slice(0, 2)));
    expect(fetch.mock.calls[2]?.[0]).toBe(urls[2]);
  });

  it("falls back after unauthorized responses and unsupported methods", async () => {
    const { rotatingFetch } = await import("./rpc");
    const urls = ["https://public.example", "https://base-mainnet.g.alchemy.com/v2/key"];
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(Response.json({ result: "ok" }))
      .mockResolvedValueOnce(Response.json({ error: { code: -32601, message: "method not found" } }))
      .mockResolvedValueOnce(Response.json({ result: "ok" }));
    vi.stubGlobal("fetch", fetch);
    const rpc = rotatingFetch(urls);
    expect(await (await rpc(urls[0] as string)).json()).toEqual({ result: "ok" });
    expect(await (await rpc(urls[0] as string)).json()).toEqual({ result: "ok" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([urls[0], urls[1], urls[0], urls[1]]);
  });

  it.each([-32603, -32002, -32004])("moves the actual viem transport past generic transient RPC code %s", async (code) => {
    const { createRpcTransport } = await import("./rpc");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const urls = ["https://public-one.example", "https://public-two.example", "https://base-mainnet.g.alchemy.com/v2/key"];
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code, message: "provider error" } }))
      .mockResolvedValueOnce(Response.json({ result: "0x2105" }));
    vi.stubGlobal("fetch", fetch);
    const client = createPublicClient({ chain: base, transport: createRpcTransport(urls) });
    expect(await client.getChainId()).toBe(8453);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(urls.slice(0, 2));
  });

  it("returns deterministic contract reverts without trying another provider", async () => {
    const { rotatingFetch } = await import("./rpc");
    const fetch = vi.fn(async (_url: string) => Response.json({ error: { code: -32000, message: "execution reverted: insufficient allowance" } }));
    vi.stubGlobal("fetch", fetch);
    const response = await rotatingFetch(["https://public.example", "https://base-mainnet.g.alchemy.com/v2/key"])("https://public.example");
    expect(await response.json()).toHaveProperty("error.message", "execution reverted: insufficient allowance");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{}, null, []])("fails over when public RPC returns a malformed payload: %j", async (payload) => {
    const { rotatingFetch } = await import("./rpc");
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(payload))
      .mockResolvedValueOnce(Response.json({ result: "ok" }));
    vi.stubGlobal("fetch", fetch);
    const response = await rotatingFetch(["https://public.example", "https://base-mainnet.g.alchemy.com/v2/key"])("https://public.example");
    expect(await response.json()).toEqual({ result: "ok" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a valid null RPC result authoritative", async () => {
    const { rotatingFetch } = await import("./rpc");
    const fetch = vi.fn(async () => Response.json({ result: null }));
    vi.stubGlobal("fetch", fetch);
    const response = await rotatingFetch(["https://public.example", "https://base-mainnet.g.alchemy.com/v2/key"])("https://public.example");
    expect(await response.json()).toEqual({ result: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("moves past a hanging public request before trying Alchemy", async () => {
    const { rotatingFetch } = await import("./rpc");
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const urls = ["https://public-one.example", "https://public-two.example", "https://base-mainnet.g.alchemy.com/v2/key"];
    const fetch = vi.fn((url: string, init?: RequestInit) => url === urls[0]
      ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }))
      : Promise.resolve(Response.json({ result: "ok" })));
    vi.stubGlobal("fetch", fetch);
    const pending = rotatingFetch(urls)(urls[0] as string);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await (await pending).json()).toEqual({ result: "ok" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 2));
  });

  it("bounds a public response that sends headers then stalls its body", async () => {
    const { rotatingFetch } = await import("./rpc");
    vi.useFakeTimers();
    const urls = ["https://public.example", "https://base-mainnet.g.alchemy.com/v2/key"];
    const fetch = vi.fn((url: string, init?: RequestInit) => url === urls[0]
      ? Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      })))
      : Promise.resolve(Response.json({ result: "ok" })));
    vi.stubGlobal("fetch", fetch);
    const pending = rotatingFetch(urls)(urls[0] as string);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await (await pending).json()).toEqual({ result: "ok" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves caller cancellation without trying another endpoint", async () => {
    const { rotatingFetch } = await import("./rpc");
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const reason = new Error("caller cancelled");
    const pending = rotatingFetch(["https://public.example", "https://base-mainnet.g.alchemy.com/v2/key"])("https://public.example", { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lets the actual viem transport reach a delayed fallback after all public nodes time out", async () => {
    const { createRpcTransport } = await import("./rpc");
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const urls = ["https://public-one.example", "https://public-two.example", "https://public-three.example", "https://base-mainnet.g.alchemy.com/v2/key"];
    const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const value = String(url);
      if (value.includes("alchemy")) setTimeout(() => resolve(Response.json({ result: "0x2105" })), 2_000);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const client = createPublicClient({ chain: base, transport: createRpcTransport(urls) });
    const pending = client.getChainId();
    await vi.advanceTimersByTimeAsync(11_001);
    expect(await pending).toBe(8453);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(urls.map((url) => new URL(url).hostname));
  });
});
