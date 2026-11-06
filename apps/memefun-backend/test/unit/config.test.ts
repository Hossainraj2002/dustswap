import { afterEach, describe, expect, it, vi } from "vitest";

import { chainRpcTransport, chainSettings } from "../../lib/chain";
import { parseDeployment } from "../../lib/deployment";
import { envBool, envInt, envList } from "../../lib/env";

const saved = { ...process.env };
const basePublicUrls = [
  "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app",
  "https://base.gateway.tenderly.co", "https://base-rpc.publicnode.com", "https://base.drpc.org",
];
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chainSettings", () => {
  it("defaults to the local chain", () => {
    delete process.env.MEMEFUN_CHAIN;
    delete process.env.MEMEFUN_RPC_URLS;
    expect(chainSettings()).toMatchObject({ key: "local", id: 31337, rpcUrls: ["http://127.0.0.1:8545"] });
  });

  it("uses public defaults with configured Alchemy URLs reserved for fallback", () => {
    process.env.MEMEFUN_CHAIN = "base";
    delete process.env.MEMEFUN_RPC_URLS;
    expect(chainSettings().rpcUrls).toEqual(basePublicUrls);
    process.env.MEMEFUN_RPC_URLS = "https://mainnet.base.org";
    expect(chainSettings().rpcUrls).toEqual(basePublicUrls);
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key-a, https://base-mainnet.g.alchemy.com/v2/key-b";
    expect(chainSettings()).toMatchObject({ id: 8453, rpcUrls: [...basePublicUrls, "https://base-mainnet.g.alchemy.com/v2/key-a", "https://base-mainnet.g.alchemy.com/v2/key-b"] });
    process.env.MEMEFUN_CHAIN = "base-sepolia";
    delete process.env.MEMEFUN_RPC_URLS;
    expect(chainSettings().rpcUrls).toEqual(["https://sepolia.base.org"]);
  });

  it("keeps custom non-Alchemy endpoints ahead of defaults and preserves local overrides", () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.alchemyapi.io/v2/key-a, https://rpc.example.com, https://rpc.example.com";
    expect(chainSettings().rpcUrls).toEqual(["https://rpc.example.com", ...basePublicUrls, "https://base-mainnet.alchemyapi.io/v2/key-a"]);
    process.env.MEMEFUN_CHAIN = "local";
    process.env.MEMEFUN_RPC_URLS = "http://localhost:9545";
    expect(chainSettings().rpcUrls).toEqual(["http://localhost:9545"]);
  });

  it("does not load balance Ponder reads onto Alchemy while public RPC succeeds", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key-a";
    const fetch = vi.fn(async (_input: string | URL | Request) => Response.json({ jsonrpc: "2.0", id: 1, result: "0x2105" }));
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    for (let i = 0; i <= basePublicUrls.length; i++) await transport.request({ method: "eth_chainId" });
    expect(fetch.mock.calls.map((args) => String(args[0]))).toEqual(
      [...basePublicUrls, basePublicUrls[0]!].map((url) => new URL(url).toString()),
    );
  });

  it("shares a persistent rate budget across parallel Ponder requests with public failover", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue-key";
    process.env.MEMEFUN_INDEXER_RPC_RPS = "5";
    const starts: number[] = [];
    const seen = new Set<string>();
    let active = 0;
    let maximumActive = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const { params } = JSON.parse(String(init?.body)) as { params: [string, string] };
      if (!seen.has(params[1])) {
        seen.add(params[1]);
        starts.push(Math.floor(Date.now() / 1_000));
      }
      const primary = String(url).startsWith("https://mainnet.base.org/");
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return primary ? new Response("Rate limited", { status: 429 }) : Response.json({ result: "0x2105" });
    });
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => transport.request({
      method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", `0x${i.toString(16)}`],
    })));
    expect(results).toEqual(Array(12).fill("0x2105"));
    const buckets = new Map<number, number>();
    for (const second of starts) buckets.set(second, (buckets.get(second) ?? 0) + 1);
    expect(Math.max(...buckets.values())).toBeLessThanOrEqual(5);
    expect(buckets.size).toBeGreaterThanOrEqual(3);
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(seen.size).toBe(12);
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith("https://base-mainnet.public.blastapi.io/"))).toBe(true);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("alchemy"))).toBe(true);
  });

  it("validates the historical indexing budget without throttling a local dev chain", () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_INDEXER_RPC_RPS = "0";
    expect(() => chainRpcTransport(chainSettings())).toThrow("MEMEFUN_INDEXER_RPC_RPS");
    process.env.MEMEFUN_CHAIN = "local";
    expect(() => chainRpcTransport(chainSettings())).not.toThrow();
  });

  it("provides persistent default capacity above Base's five-block-per-second cadence", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue-key";
    delete process.env.MEMEFUN_INDEXER_RPC_RPS;
    const starts: number[] = [];
    const seen = new Set<string>();
    let active = 0;
    let maximumActive = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const { params } = JSON.parse(String(init?.body)) as { params: [string, string] };
      if (!seen.has(params[1])) {
        seen.add(params[1]);
        starts.push(Math.floor(Date.now() / 1_000));
      }
      const primary = String(url).startsWith("https://mainnet.base.org/");
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return primary ? new Response("Rate limited", { status: 429 }) : Response.json({ result: "0x2105" });
    });
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    const results = await Promise.all(Array.from({ length: 66 }, (_, i) => transport.request({
      method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", `0x${i.toString(16)}`],
    })));
    expect(results).toEqual(Array(66).fill("0x2105"));
    const buckets = new Map<number, number>();
    for (const second of starts) buckets.set(second, (buckets.get(second) ?? 0) + 1);
    expect(Math.max(...buckets.values())).toBe(30);
    expect(buckets.size).toBeGreaterThanOrEqual(3);
    expect(maximumActive).toBeLessThanOrEqual(8);
    expect(seen.size).toBe(66);
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith("https://base-mainnet.public.blastapi.io/"))).toBe(true);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("alchemy"))).toBe(true);
  });

  it("reaches Alchemy when public RPCs cannot serve an indexing method", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key-a";
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).includes("alchemy")
      ? Response.json({ jsonrpc: "2.0", id: 1, result: [] })
      : Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not supported" } }));
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    expect(await transport.request({ method: "eth_getLogs", params: [{}] })).toEqual([]);
    expect(fetch.mock.calls.map((args) => String(args[0]))).toEqual(chain.rpcUrls.map((url) => new URL(url).toString()));
    fetch.mockClear();
    expect(await transport.request({ method: "eth_getLogs", params: [{}] })).toEqual([]);
    expect(fetch.mock.calls.map((args) => String(args[0]))).toEqual([
      ...chain.rpcUrls.slice(1, -1), chain.rpcUrls[0], chain.rpcUrls.at(-1),
    ].map((url) => new URL(url!).toString()));
  });

  it.each(["http", "rpc"])("cools a %s rate limit and probes the public provider again after 30 seconds", async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue-key";
    let limited = true;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith("https://mainnet.base.org/") && limited) {
        return kind === "http" ? new Response("Rate limited", { status: 429 })
          : Response.json({ error: { code: -32011, message: "request limit reached" } });
      }
      return Response.json({ result: "0x2105" });
    });
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    for (let i = 0; i < basePublicUrls.length * 2; i++) expect(await transport.request({ method: "eth_chainId" })).toBe("0x2105");
    const primaryCalls = () => fetch.mock.calls.filter(([url]) => String(url).startsWith("https://mainnet.base.org/")).length;
    expect(primaryCalls()).toBe(1);
    limited = false;
    vi.setSystemTime(new Date("2026-11-06T12:00:30Z"));
    for (let i = 0; i <= basePublicUrls.length; i++) expect(await transport.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(primaryCalls()).toBe(3);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("alchemy"))).toBe(true);
  });

  it("keeps Alchemy last when all public providers are cooling down", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/fallback-key";
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("alchemy")
      ? Response.json({ result: "0x2105" }) : new Response("Rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    expect(await transport.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(chain.rpcUrls.map((url) => new URL(url).toString()));
    fetch.mockClear();
    expect(await transport.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([new URL(chain.rpcUrls.at(-1)!).toString()]);
  });

  it.each(["http", "rpc"])("preserves public %s rate limits and bounds inactive Alchemy retries", async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T17:00:00Z"));
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: [
      "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-mainnet.g.alchemy.com/v2/inactive-key",
    ] };
    let paidActive = false;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("alchemy")) return paidActive ? Response.json({ result: [] })
        : Response.json({ error: { code: -32600, message: "App is inactive. Please create a new app." } });
      return kind === "http" ? new Response("Public capacity reached", { status: 429 })
        : Response.json({ error: { code: -32011, message: "Public request limit reached" } });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    const read = () => transport.request({ method: "eth_getLogs", params: [{}] });
    for (let i = 0; i < 3; i++) {
      await expect(read()).rejects.toMatchObject({
        status: 429,
        details: expect.stringContaining(kind === "http" ? "Public capacity reached" : "Public request limit reached"),
        ...(kind === "rpc" ? { cause: { code: -32011 } } : {}),
      });
    }
    const paidCalls = () => fetch.mock.calls.filter(([url]) => String(url).includes("alchemy")).length;
    expect(paidCalls()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date("2026-11-06T17:02:00Z"));
    await expect(read()).rejects.toMatchObject({ status: 429 });
    expect(paidCalls()).toBe(2);
    paidActive = true;
    vi.setSystemTime(new Date("2026-11-06T17:04:00Z"));
    expect(await read()).toEqual([]);
    expect(paidCalls()).toBe(3);
  });

  it("keeps public block reads available when only log requests are rate limited", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://mainnet.base.org", "https://base-mainnet.g.alchemy.com/v2/inactive-key"] };
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("alchemy")) return Response.json({ error: { code: -32600, message: "App is inactive" } });
      const { method } = JSON.parse(String(init?.body)) as { method: string };
      return method === "eth_getLogs" ? new Response("Rate limited", { status: 429 })
        : Response.json({ result: { number: "0x123" } });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    await expect(transport.request({ method: "eth_getLogs", params: [{}] })).rejects.toMatchObject({ status: 429 });
    expect(await transport.request({ method: "eth_getBlockByNumber", params: ["latest", false] })).toEqual({ number: "0x123" });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://mainnet.base.org/", "https://base-mainnet.g.alchemy.com/v2/inactive-key", "https://mainnet.base.org/",
    ]);
  });

  it("tries a healthy second Alchemy key after an inactive first key and cools only the inactive key", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: [
      "https://mainnet.base.org", "https://base-mainnet.g.alchemy.com/v2/inactive-key", "https://base-mainnet.g.alchemy.com/v2/active-key",
    ] };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("inactive-key")) return Response.json({ error: { code: -32600, message: "App is inactive" } });
      if (String(url).includes("active-key")) return Response.json({ result: [] });
      return new Response("Rate limited", { status: 429 });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    for (let i = 0; i < 2; i++) expect(await transport.request({ method: "eth_getLogs", params: [{}] })).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://mainnet.base.org/", "https://base-mainnet.g.alchemy.com/v2/inactive-key",
      "https://base-mainnet.g.alchemy.com/v2/active-key", "https://base-mainnet.g.alchemy.com/v2/active-key",
    ]);
  });

  it.each(["invalid-key", "billing"])("circuits explicit paid %s failures while keeping the public capacity error", async (kind) => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://mainnet.base.org", "https://base-mainnet.g.alchemy.com/v2/key"] };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes("alchemy")) return new Response("Rate limited", { status: 429 });
      return kind === "billing" ? new Response("Payment required", { status: 402 })
        : Response.json({ error: { code: -32600, message: "Invalid API key" } });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    for (let i = 0; i < 2; i++) await expect(transport.request({ method: "eth_getLogs", params: [{}] })).rejects.toMatchObject({ status: 429 });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("alchemy"))).toHaveLength(1);
  });

  it("preserves a genuine paid execution error and does not classify it as an inactive key", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://mainnet.base.org", "https://base-mainnet.g.alchemy.com/v2/key"] };
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("alchemy")
      ? Response.json({ error: { code: 3, message: "execution reverted: app is inactive" } })
      : new Response("Rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    for (let i = 0; i < 2; i++) {
      await expect(transport.request({ method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001" }, "latest"] })).rejects.toMatchObject({ code: 3, details: "execution reverted: app is inactive" });
    }
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("alchemy"))).toHaveLength(2);
  });

  it("allows only one expired inactive-key probe while other requests keep their public error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T17:00:00Z"));
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://mainnet.base.org", "https://base-mainnet.g.alchemy.com/v2/inactive-key"] };
    let probes = 0;
    let finishProbe: (() => void) | undefined;
    const inactive = () => Response.json({ error: { code: -32600, message: "App is inactive" } });
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes("alchemy")) return new Response("Rate limited", { status: 429 });
      probes += 1;
      if (probes === 1) return inactive();
      return new Promise<Response>((resolve) => { finishProbe = () => resolve(inactive()); });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    const read = () => transport.request({ method: "eth_getLogs", params: [{}] });
    await expect(read()).rejects.toMatchObject({ status: 429 });
    vi.setSystemTime(new Date("2026-11-06T17:02:00Z"));
    const probe = read();
    await vi.waitFor(() => expect(probes).toBe(2));
    await expect(read()).rejects.toMatchObject({ status: 429 });
    expect(probes).toBe(2);
    finishProbe!();
    await expect(probe).rejects.toMatchObject({ status: 429 });
  });

  it("times out a stalled public fetch, uses a healthy public peer, and recovers after cooldown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T17:00:00Z"));
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: [
      "https://mainnet.base.org", "https://base-mainnet.public.blastapi.io", "https://base-mainnet.g.alchemy.com/v2/key",
    ] };
    let stalled = true;
    let aborted = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://mainnet.base.org/") && stalled) {
        return new Promise<Response>((_resolve, reject) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          init!.signal!.addEventListener("abort", () => {
            aborted += 1;
            reject(new DOMException("Fetch aborted", "AbortError"));
          }, { once: true });
        });
      }
      return Response.json({ result: "0x2105" });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain, 20)({ chain: chain.viemChain });
    for (let i = 0; i < 3; i++) expect(await transport.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(aborted).toBe(1);
    const primaryCalls = () => fetch.mock.calls.filter(([url]) => String(url).startsWith("https://mainnet.base.org/")).length;
    expect(primaryCalls()).toBe(1);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://mainnet.base.org/", "https://base-mainnet.public.blastapi.io/",
      "https://base-mainnet.public.blastapi.io/", "https://base-mainnet.public.blastapi.io/",
    ]);
    stalled = false;
    vi.setSystemTime(new Date("2026-11-06T17:00:30Z"));
    for (let i = 0; i < 2; i++) expect(await transport.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(primaryCalls()).toBe(2);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("alchemy"))).toBe(true);
  });

  it("fails over an unsupported full-block method without disabling other reads on that public node", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base-pokt.nodies.app", "https://base-mainnet.public.blastapi.io", "https://base-mainnet.g.alchemy.com/v2/key"] };
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [string, boolean] };
      return String(url).includes("nodies") && body.params[1]
        ? Response.json({ error: { code: -32601, message: "Method not available on this plan; request without full transaction bodies" } })
        : Response.json({ result: { number: "0x123" } });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    for (const full of [true, false, false]) {
      expect(await transport.request({ method: "eth_getBlockByNumber", params: ["0x123", full] })).toEqual({ number: "0x123" });
    }
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://base-pokt.nodies.app/", "https://base-mainnet.public.blastapi.io/",
      "https://base-mainnet.public.blastapi.io/", "https://base-pokt.nodies.app/",
    ]);
  });

  it("preserves an authoritative execution error instead of trying another provider", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const fetch = vi.fn(async () => Response.json({ error: { code: 3, message: "execution reverted" } }));
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    await expect(transport.request({ method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001" }, "latest"] })).rejects.toMatchObject({ details: "execution reverted" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves public log range limits so Ponder can split requests without Alchemy", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue-key";
    const message = "eth_getLogs is limited to a 10,000 blocks range";
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ fromBlock: string; toBlock: string }] };
      return BigInt(body.params[0].toBlock) - BigInt(body.params[0].fromBlock) >= 10_000n
        ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message } })
        : Response.json({ jsonrpc: "2.0", id: 1, result: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x4e20" }] })).rejects.toMatchObject({ details: message });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x1388" }] })).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["https://mainnet.base.org/", "https://base-mainnet.public.blastapi.io/"]);
  });

  it("fails over when a public node cannot serve archive state", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: -32000, message: "requested block range is unavailable: missing trie node" } }))
      .mockResolvedValueOnce(Response.json({ result: [] }));
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    expect(await transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x1" }] })).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["https://mainnet.base.org/", "https://base-mainnet.public.blastapi.io/"]);
  });

  it("rejects unknown chains", () => {
    process.env.MEMEFUN_CHAIN = "mainnet";
    expect(() => chainSettings()).toThrow("MEMEFUN_CHAIN must be one of");
  });
});

describe("parseDeployment", () => {
  const record = {
    chainId: 84532,
    deployedAtBlock: 10,
    poolManager: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408",
    config: "0x0000000000000000000000000000000000000002",
    feeVault: "0x0000000000000000000000000000000000000003",
    factory: "0x0000000000000000000000000000000000000004",
    router: "0x0000000000000000000000000000000000000005",
    hook: "0x0000000000000000000000000000000000000006",
    buybackBurnVault: "0x0000000000000000000000000000000000000007",
    floorVault: "0x0000000000000000000000000000000000000008",
    holderRewardDistributor: "0x0000000000000000000000000000000000000009",
    ethUsdFeed: "0x000000000000000000000000000000000000000a",
    usdc: "0x000000000000000000000000000000000000000b",
    owner: "0x000000000000000000000000000000000000000c",
    treasury: "0x000000000000000000000000000000000000000d",
    priceKeeper: "0x0000000000000000000000000000000000000000",
    rewardsPublisher: "0x0000000000000000000000000000000000000000",
  };

  it("checksums addresses and checks the chain", () => {
    const d = parseDeployment(record, 84532);
    expect(d.poolManager).toBe("0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408");
    expect(() => parseDeployment(record, 8453)).toThrow("expected 8453");
  });

  it("refuses a record with a bad address", () => {
    expect(() => parseDeployment({ ...record, hook: "0x1234" })).toThrow();
  });
});

describe("env helpers", () => {
  it("parse lists, booleans and bounded integers", () => {
    process.env.T_LIST = " a, b  c ,";
    process.env.T_BOOL = "yes";
    process.env.T_INT = "42";
    expect(envList("T_LIST")).toEqual(["a", "b", "c"]);
    expect(envBool("T_BOOL", false)).toBe(true);
    expect(envBool("T_MISSING", true)).toBe(true);
    expect(envInt("T_INT", 0, { max: 100 })).toBe(42);
    expect(() => envInt("T_INT", 0, { max: 10 })).toThrow("at most 10");
    process.env.T_BOOL = "maybe";
    expect(() => envBool("T_BOOL", false)).toThrow();
  });
});
