import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError } from "viem";

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
    expect(Math.max(...buckets.values())).toBeLessThanOrEqual(30);
    expect(Math.max(...buckets.values())).toBeGreaterThan(5);
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
    expect(primaryCalls()).toBeGreaterThan(1);
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

  it("preserves a public log range limit only after every alternative fails", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue-key";
    const message = "eth_getLogs is limited to a 10,000 blocks range";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("alchemy")) return Response.json({ error: { code: -32600, message: "App is inactive" } });
      const body = JSON.parse(String(init?.body)) as { params: [{ fromBlock: string; toBlock: string }] };
      return BigInt(body.params[0].toBlock) - BigInt(body.params[0].fromBlock) >= 10_000n
        ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message } })
        : Response.json({ jsonrpc: "2.0", id: 1, result: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const chain = chainSettings();
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x4e20" }] })).rejects.toMatchObject({ details: message });
    expect(fetch).toHaveBeenCalledTimes(chain.rpcUrls.length);
    expect(await transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x1388" }] })).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      ...chain.rpcUrls.map((url) => new URL(url).toString()), "https://base-mainnet.public.blastapi.io/",
    ]);
  });

  it("tries a capable public node after Blast's exact ten-block rejection and caches only oversized shapes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T03:20:00Z"));
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: [
      "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base-mainnet.g.alchemy.com/v2/inactive-key",
    ] };
    const message = "You can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x33a561e, 0x33a5627]";
    let expanded = false;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const { params } = JSON.parse(String(init?.body)) as { params: [{ fromBlock: string; toBlock: string }] };
      const blocks = BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) + 1n;
      return String(url).includes("blastapi") && blocks > 10n && !expanded
        ? Response.json({ error: { code: -32600, message } }, { status: 400 }) : Response.json({ result: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    const read = (toBlock = "0x33a5637") => transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x33a561e", toBlock }] });
    for (let i = 0; i < 3; i++) expect(await read()).toEqual([]);
    const blastCalls = () => fetch.mock.calls.filter(([url]) => String(url).includes("blastapi")).length;
    expect(blastCalls()).toBe(1);
    for (let i = 0; i < 2; i++) expect(await read("0x33a5627")).toEqual([]);
    expect(blastCalls()).toBeGreaterThan(1);
    const beforeExpiry = blastCalls();
    expanded = true;
    vi.setSystemTime(new Date("2026-11-07T03:25:00Z"));
    for (let i = 0; i < 2; i++) expect(await read()).toEqual([]);
    expect(blastCalls()).toBeGreaterThan(beforeExpiry);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("alchemy"))).toBe(true);
  });

  it("returns the most permissive public range hint after all providers fail", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base-mainnet.g.alchemy.com/v2/inactive-key"] };
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("alchemy")
      ? Response.json({ error: { code: -32600, message: "App is inactive" } })
      : Response.json({ error: { code: -32602, message: `eth_getLogs is limited to ${String(url).includes("blastapi") ? "10" : "10,000"} blocks range` } }));
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x4e20" }] })).rejects.toMatchObject({ details: "eth_getLogs is limited to 10,000 blocks range" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("uses actionable Nodies fifty-block hints instead of a contradictory ten-thousand-block hint", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: [
      "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.drpc.org",
      "https://base.gateway.tenderly.co", "https://base-mainnet.g.alchemy.com/v2/inactive-key",
    ] };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const endpoint = String(url);
      if (endpoint.includes("blastapi")) return Response.json({ error: { code: -32600, message: "eth_getLogs is limited to 10 blocks range" } });
      if (endpoint.includes("nodies")) return Response.json({ error: { code: -32001, message: "Block range too large: maximum allowed is 50 blocks on your current plan" } });
      if (endpoint.includes("drpc")) return Response.json({ error: { code: 35, message: "ranges over 10000 blocks are not supported on free plan" } });
      if (endpoint.includes("tenderly")) return new Response("Rate limited", { status: 429 });
      return Response.json({ error: { code: -32600, message: "App is inactive" } });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x3e7" }] })).rejects.toMatchObject({
      code: -32001, details: expect.stringContaining("eth_getLogs is limited to 50 blocks range"),
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("keeps contradictory range wording out of the native splitter while retaining its original cause", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base.drpc.org", "https://base-mainnet.g.alchemy.com/v2/inactive-key"] };
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("alchemy")
      ? Response.json({ error: { code: -32600, message: "App is inactive" } })
      : Response.json({ error: { code: 35, message: "ranges over 10000 blocks are not supported on free plan" } }));
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    const error: unknown = await transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x3e7" }] }).catch(error => error);
    expect(error).toMatchObject({ status: 503, cause: { code: 35, details: "ranges over 10000 blocks are not supported on free plan" } });
    expect(JSON.stringify(error)).not.toContain("ranges over 10000");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "a recent wider peer's 429", peer: "rate", expected: "rate" },
    { name: "a recent wider peer's timeout", peer: "timeout", expected: "timeout" },
    { name: "expired successful-range evidence", peer: "rate", expected: "range", expired: true },
    { name: "a different address-count shape", peer: "rate", expected: "range", differentShape: true },
    { name: "a corroborated limit above the proven range", peer: "rate", expected: "range", limit: 10_000 },
    { name: "a new hard limit from the formerly wider peer", peer: "range", expected: "range" },
  ])("handles $name without permanently shrinking a known healthy range", async (scenario) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T04:00:00Z"));
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: [
      "https://base.gateway.tenderly.co", "https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app",
      "https://base-mainnet.g.alchemy.com/v2/inactive-key",
    ] };
    let warmed = false;
    const limit = scenario.limit ?? 50;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const endpoint = String(url);
      if (endpoint.includes("tenderly")) {
        if (!warmed) return Response.json({ result: [] });
        if (scenario.peer === "timeout") throw new TimeoutError({ url: endpoint, body: { method: "eth_getLogs" } });
        if (scenario.peer === "rate") return new Response("Rate limited", { status: 429 });
        return Response.json({ error: { code: -32600, message: `eth_getLogs is limited to ${limit} blocks range` } });
      }
      if (endpoint.includes("alchemy")) return Response.json({ error: { code: -32600, message: "App is inactive" } });
      return Response.json({ error: { code: -32600, message: `eth_getLogs is limited to ${endpoint.includes("blastapi") ? 10 : limit} blocks range` } });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    const addresses = Array.from({ length: 50 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const read = (blocks: number, address = addresses) => transport.request({
      method: "eth_getLogs", params: [{ address, fromBlock: "0x0", toBlock: `0x${(blocks - 1).toString(16)}` }],
    });
    expect(await read(1_000, scenario.differentShape ? addresses.slice(0, 1) : addresses)).toEqual([]);
    warmed = true;
    if (scenario.expired) vi.setSystemTime(new Date("2026-11-07T04:05:01Z"));
    const request = read(scenario.limit === 10_000 ? 15_000 : 1_000);
    if (scenario.expected === "rate") await expect(request).rejects.toMatchObject({ status: 429 });
    else if (scenario.expected === "timeout") await expect(request).rejects.toBeInstanceOf(TimeoutError);
    else await expect(request).rejects.toMatchObject({ details: `eth_getLogs is limited to ${limit} blocks range` });
  });

  it.each([false, true])("uses a corroborated public range despite a throttled peer (capacity first: %s)", async (capacityFirst) => {
    process.env.MEMEFUN_CHAIN = "base";
    const providers = ["https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://base.gateway.tenderly.co", "https://mainnet.base.org"];
    const chain = { ...chainSettings(), rpcUrls: [...(capacityFirst ? providers.toReversed() : providers), "https://base-mainnet.g.alchemy.com/v2/inactive-key"] };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("alchemy")) return Response.json({ error: { code: -32600, message: "App is inactive" } });
      if (String(url).startsWith("https://mainnet.base.org/")) return new Response("Public capacity reached", { status: 429 });
      return Response.json({ error: { code: -32602, message: `eth_getLogs is limited to ${String(url).includes("blastapi") ? "10" : "10,000"} blocks range` } });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x4e20" }] })).rejects.toMatchObject({ details: "eth_getLogs is limited to 10,000 blocks range" });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("uses the corroborated public limit instead of a larger failed paid-provider hint", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app", "https://mainnet.base.org", "https://base-mainnet.g.alchemy.com/v2/key"] };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith("https://mainnet.base.org/")) return new Response("Public capacity reached", { status: 429 });
      const limit = String(url).includes("blastapi") ? "10" : String(url).includes("alchemy") ? "100,000" : "10,000";
      return Response.json({ error: { code: -32602, message: `eth_getLogs is limited to ${limit} blocks range` } });
    }));
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x30d40" }] })).rejects.toMatchObject({ details: "eth_getLogs is limited to 10,000 blocks range" });
  });

  it.each([404, 405, 501, 505])("does not let an unavailable HTTP %s peer mask a public range hint", async (status) => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base-pokt.nodies.app", "https://base.gateway.tenderly.co"] };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).includes("nodies")
      ? Response.json({ error: { code: -32602, message: "eth_getLogs is limited to 10,000 blocks range" } })
      : new Response("Unsupported endpoint", { status })));
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x4e20" }] })).rejects.toMatchObject({ details: "eth_getLogs is limited to 10,000 blocks range" });
  });

  it("caches an explicit public address limit and serves repeated fifty-address queries through a capable peer", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base-mainnet.g.alchemy.com/v2/key"] };
    const addresses = Array.from({ length: 50 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("publicnode")
      ? Response.json({ error: { code: -32602, message: "A maximum of 10 addresses is allowed. No limit on a dedicated node" } }, { status: 403 })
      : Response.json({ result: [] }));
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    for (let i = 0; i < 3; i++) {
      expect(await transport.request({ method: "eth_getLogs", params: [{ address: addresses, fromBlock: "0x0", toBlock: "0x19" }] })).toEqual([]);
    }
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("publicnode"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("drpc"))).toHaveLength(3);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("alchemy"))).toBe(true);
  });

  it("keeps small address lists, single addresses and heads usable and probes an expired address cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T03:20:00Z"));
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base-rpc.publicnode.com", "https://base.drpc.org"] };
    const addresses = Array.from({ length: 50 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    let expanded = false;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: [{ address: string | string[] }] };
      if (body.method !== "eth_getLogs") return Response.json({ result: "0x123" });
      return String(url).includes("publicnode") && Array.isArray(body.params?.[0].address) && body.params[0].address.length > 10 && !expanded
        ? Response.json({ error: { code: -32602, message: "A maximum of 10 addresses is allowed" } }, { status: 403 })
        : Response.json({ result: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    const read = (address: string | string[]) => transport.request({ method: "eth_getLogs", params: [{ address, fromBlock: "0x0", toBlock: "0x19" }] });
    expect(await read(addresses)).toEqual([]);
    for (const address of [addresses.slice(0, 10), addresses[0]!]) {
      for (let i = 0; i < 2; i++) expect(await read(address)).toEqual([]);
    }
    for (let i = 0; i < 2; i++) expect(await transport.request({ method: "eth_blockNumber" })).toBe("0x123");
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("publicnode"))).toHaveLength(4);
    expanded = true;
    vi.setSystemTime(new Date("2026-11-07T03:25:00Z"));
    for (let i = 0; i < 2; i++) expect(await read(addresses)).toEqual([]);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("publicnode"))).toHaveLength(5);
  });

  it.each([false, true])("preserves public capacity instead of shrinking to another node's range hint (capacity first: %s)", async (capacityFirst) => {
    process.env.MEMEFUN_CHAIN = "base";
    const publicUrls = ["https://base-mainnet.public.blastapi.io", "https://base-pokt.nodies.app"];
    const chain = { ...chainSettings(), rpcUrls: [...(capacityFirst ? publicUrls.toReversed() : publicUrls), "https://base-mainnet.g.alchemy.com/v2/inactive-key"] };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("alchemy")) return Response.json({ error: { code: -32600, message: "App is inactive" } });
      return String(url).includes("blastapi") ? Response.json({ error: { code: -32600, message: "eth_getLogs is limited to 10 blocks range" } })
        : new Response("Public capacity reached", { status: 429 });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x19" }] })).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("allows a healthy paid fallback to serve a range unavailable on every public node", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base-mainnet.public.blastapi.io", "https://base-mainnet.g.alchemy.com/v2/active-key"] };
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("alchemy") ? Response.json({ result: [] })
      : Response.json({ error: { code: -32600, message: "eth_getLogs is limited to 10 blocks range" } }));
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    expect(await transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x19" }] })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves a genuine execution error after an earlier public range rejection", async () => {
    process.env.MEMEFUN_CHAIN = "base";
    const chain = { ...chainSettings(), rpcUrls: ["https://base-mainnet.public.blastapi.io", "https://base-mainnet.g.alchemy.com/v2/active-key"] };
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("alchemy")
      ? Response.json({ error: { code: 3, message: "execution reverted" } })
      : Response.json({ error: { code: -32600, message: "eth_getLogs is limited to 10 blocks range" } }));
    vi.stubGlobal("fetch", fetch);
    const transport = chainRpcTransport(chain)({ chain: chain.viemChain, retryCount: 0 });
    await expect(transport.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x19" }] })).rejects.toMatchObject({ code: 3, details: "execution reverted" });
    expect(fetch).toHaveBeenCalledTimes(2);
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
