import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";

import { chainSettings, keeperRpcTransport } from "../../lib/chain";

const saved = { ...process.env };
const signedTransaction = "0x02deadbeef";
const hash = `0x${"ab".repeat(32)}`;

beforeEach(() => {
  process.env.MEMEFUN_CHAIN = "base";
  process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/overdue-fixture";
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

function client() {
  const chain = chainSettings();
  return createPublicClient({ chain: chain.viemChain, transport: keeperRpcTransport(chain) });
}

describe("keeper RPC failover", () => {
  it.each([
    "nonce too low",
    "nonce too high",
    "insufficient funds for gas * price + value",
    "replacement transaction underpriced",
    "transaction underpriced",
    "already known",
    "invalid sender",
    "invalid signature",
    "intrinsic gas too low",
  ])("preserves a public transaction rejection: %s", async (message) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: -32000, message } }))
      .mockImplementation(async () => new Response("Account overdue", { status: 402 }));
    vi.stubGlobal("fetch", fetch);
    await expect(client().sendRawTransaction({ serializedTransaction: signedTransaction })).rejects.toMatchObject({ details: message });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://mainnet.base.org/");
  });

  it.each([
    { code: -32003, message: "transaction rejected" },
    { code: 4001, message: "user rejected request" },
    { code: 3, message: "execution reverted" },
  ])("preserves viem's default authoritative errors: $code", async (error) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error }))
      .mockImplementation(async () => new Response("Account overdue", { status: 402 }));
    vi.stubGlobal("fetch", fetch);
    await expect(client().sendRawTransaction({ serializedTransaction: signedTransaction })).rejects.toMatchObject({ details: error.message });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses public RPC only when the primary is healthy", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) => Response.json({ result: "0x2105" }));
    vi.stubGlobal("fetch", fetch);
    expect(await client().getChainId()).toBe(8453);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://mainnet.base.org/");
  });

  it("retries a true transport failure on another public node with identical signed bytes", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ result: hash }));
    vi.stubGlobal("fetch", fetch);
    expect(await client().sendRawTransaction({ serializedTransaction: signedTransaction })).toBe(hash);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["https://mainnet.base.org/", "https://base-mainnet.public.blastapi.io/"]);
    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ method: "eth_sendRawTransaction", params: [signedTransaction] });
    }
  });

  it("reaches Alchemy only after every public provider has a transport failure", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("alchemy")
      ? Response.json({ result: hash }) : new Response("Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    expect(await client().sendRawTransaction({ serializedTransaction: signedTransaction })).toBe(hash);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(chainSettings().rpcUrls.map((url) => new URL(url).toString()));
  });

  it("does not apply Ponder's range-splitting policy to keeper reads", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: -32602, message: "eth_getLogs is limited to a 10,000 blocks range" } }))
      .mockResolvedValueOnce(Response.json({ result: [] }));
    vi.stubGlobal("fetch", fetch);
    expect(await client().getLogs({ fromBlock: 0n, toBlock: 20_000n })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
