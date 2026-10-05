import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { captureAuthorCompletion, consumeAuthorConnectionFailure, AuthorCompletion } from "./authorCompletion";
import { ApiError, createApi, type ApiClient } from "./api";
import { LiveMarket } from "./LiveMarket";
import { saveSession } from "./session";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const COMPLETION = "A".repeat(43);
const NOW = Date.UTC(2026, 9, 4, 12);
const AUTHOR = { id: "42", handle: "alice", name: "Alice", verifiedAt: new Date(NOW).toISOString() };
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function browser(hash = `#authorCompletion=${COMPLETION}`) {
  const stored = new Map<string, string>();
  const value = {
    location: { hash, pathname: "/rewards/author", search: "?coin=0x123", origin: "https://memefun.test", host: "memefun.test" },
    history: { state: { existing: true }, replaceState: vi.fn() },
    sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, data: string) => { stored.set(key, data); }, removeItem: (key: string) => { stored.delete(key); } },
  };
  value.history.replaceState.mockImplementation((_state: unknown, _unused: string, target: string) => {
    const url = new URL(target, value.location.origin);
    value.location.hash = url.hash;
    value.location.search = url.search;
  });
  vi.stubGlobal("window", value);
  return { value, stored };
}

function fixture(handler?: (auth: string, payload: { token: string }) => Promise<Response> | Response) {
  const captured = browser();
  let clock = NOW;
  const calls: Array<{ path: string; auth: string | null; payload?: unknown }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, auth, payload });
    if (url.pathname === "/v1/author/complete") return handler ? handler(auth ?? "", payload) : new Response(JSON.stringify({ author: AUTHOR }));
    if (url.pathname === "/v1/author/me") return new Response(JSON.stringify({ author: null }));
    throw new Error("Unexpected route");
  });
  const prompt = vi.fn().mockRejectedValue(new Error("Read hooks must not prompt a wallet"));
  const market = new LiveMarket({ api: createApi("https://api.test", fetch), client: {} as PublicClient, now: () => clock, txContext: prompt });
  const signed = (wallet: typeof A | typeof B, token: string) => saveSession({ address: wallet, token, expiresAt: NOW + 3_600_000 });
  return { ...captured, calls, market, prompt, signed, advance: (ms: number) => { clock += ms; } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("secure X browser callback completion", () => {
  it("consumes a failed X connection flag once without removing the selected coin or completion fragment", () => {
    const { value, stored } = browser();
    value.location.search = "?coin=0x123&authorLinked=0";
    expect(consumeAuthorConnectionFailure(value)).toBe(true);
    expect(value.history.replaceState).toHaveBeenCalledWith({ existing: true }, "", `/rewards/author?coin=0x123#authorCompletion=${COMPLETION}`);
    expect(consumeAuthorConnectionFailure(value)).toBe(false);
    expect(captureAuthorCompletion(value)).toBe(COMPLETION);
    expect(value.location.hash).toBe("");
    expect(stored.size).toBe(0);
  });
  it("removes the callback token immediately while preserving the coin query and harmless fragment", () => {
    const { value, stored } = browser(`#authorCompletion=${COMPLETION}&section=fees`);
    expect(captureAuthorCompletion(value)).toBe(COMPLETION);
    expect(value.history.replaceState).toHaveBeenCalledWith({ existing: true }, "", "/rewards/author?coin=0x123#section=fees");
    expect(value.location.hash).not.toContain(COMPLETION);
    expect(stored.size).toBe(0);
    expect(captureAuthorCompletion(value)).toBeNull();
  });

  it.each(["short", `${COMPLETION}&authorCompletion=${COMPLETION}`, `${COMPLETION.slice(0, 42)}+`])("strips and rejects malformed or duplicate callback credentials (%s)", (token) => {
    const { value } = browser(`#authorCompletion=${token}`);
    expect(captureAuthorCompletion(value)).toBeNull();
    expect(value.location.hash).toBe("");
  });

  it("keeps the callback only in memory and makes no request or wallet prompt without an existing SIWE session", async () => {
    const test = fixture();
    expect(test.value.location.hash).toBe("");
    expect(test.market.getAuthorSession(A)).toBeNull();
    await flush();
    expect(test.calls).toEqual([]);
    expect(test.prompt).not.toHaveBeenCalled();
    expect([...test.stored.values()].join("")).not.toContain(COMPLETION);
    test.signed(A, "bearer-for-a");
    test.market.getAuthorSession(A);
    await flush();
    expect(test.calls).toEqual([{ path: "/v1/author/complete", auth: "Bearer bearer-for-a", payload: { token: COMPLETION } }]);
    expect(test.market.getAuthorSession(A)?.authorId).toBe("42");
    expect(test.prompt).not.toHaveBeenCalled();
  });

  it("uses the current wallet's exact session, does not attach on a wrong wallet, and retries with the correct wallet", async () => {
    const test = fixture((auth) => auth === "Bearer bearer-for-a" ? new Response(JSON.stringify({ author: AUTHOR }))
      : new Response(JSON.stringify({ error: { code: "x_oauth_completion_wallet_mismatch", message: "Wrong wallet" } }), { status: 403 }));
    test.signed(A, "bearer-for-a"); test.signed(B, "bearer-for-b");
    test.market.getAuthorSession(B); await flush();
    expect(test.market.getAuthorSession(B)).toBeNull();
    expect(test.calls[0]!.auth).toBe("Bearer bearer-for-b");
    test.advance(11_000); test.market.getAuthorSession(B); await flush();
    expect(test.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(1);
    test.market.getAuthorSession(A); await flush();
    expect(test.calls.filter((call) => call.path.endsWith("/complete")).map((call) => call.auth)).toEqual(["Bearer bearer-for-b", "Bearer bearer-for-a"]);
    expect(test.market.getAuthorSession(A)?.handle).toBe("alice");
    expect(test.market.getAuthorSession(B)).toBeNull();
    expect([...test.stored.values()].join("")).not.toContain(COMPLETION);
  });

  it.each(["x_oauth_completion_expired", "x_oauth_completion_invalid", "invalid_request"])("discards terminal completion failures (%s) before reading the authenticated identity", async (code) => {
    const test = fixture(() => new Response(JSON.stringify({ error: { code, message: "Completion is unavailable" } }), { status: code === "x_oauth_completion_expired" ? 410 : 400 }));
    test.signed(A, "bearer-for-a");
    test.market.getAuthorSession(A); await flush();
    expect(test.calls.map((call) => call.path)).toEqual(["/v1/author/complete", "/v1/author/me"]);
    test.advance(11_000); test.market.getAuthorSession(A); await flush();
    expect(test.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(1);
    expect(test.market.getAuthorSession(A)).toBeNull();
  });

  it("does not reuse a rejected SIWE bearer or automatically request a new wallet signature", async () => {
    const test = fixture(() => new Response(JSON.stringify({ error: { code: "sign_in_required", message: "Sign in" } }), { status: 401 }));
    test.signed(A, "revoked-bearer");
    test.market.getAuthorSession(A); await flush();
    test.advance(60_000); test.market.getAuthorSession(A); await flush();
    expect(test.calls).toHaveLength(1);
    expect(test.prompt).not.toHaveBeenCalled();
    expect(test.stored.size).toBe(0);
    test.signed(A, "new-bearer");
    test.market.getAuthorSession(A); await flush();
    expect(test.calls[1]!.auth).toBe("Bearer new-bearer");
  });

  it("expires a retained wrong-wallet token locally after five minutes", async () => {
    const test = fixture(() => new Response(JSON.stringify({ error: { code: "x_oauth_completion_wallet_mismatch", message: "Wrong wallet" } }), { status: 403 }));
    test.signed(B, "bearer-for-b"); test.market.getAuthorSession(B); await flush();
    test.advance(5 * 60_000); test.signed(A, "bearer-for-a");
    test.market.getAuthorSession(A); await flush();
    expect(test.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(1);
    expect(test.calls.at(-1)).toEqual({ path: "/v1/author/me", auth: "Bearer bearer-for-a", payload: undefined });
  });

  it("shares one in-flight completion and retains it after a temporary server failure", async () => {
    const { value } = browser();
    let resolve!: (value: { author: typeof AUTHOR }) => void;
    const post = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockRejectedValueOnce(new ApiError(503, "temporary", "Try later"));
    const complete = new AuthorCompletion({ post } as unknown as ApiClient, () => NOW, value);
    const first = complete.complete(A, "a");
    const second = complete.complete(A, "a");
    expect(post).toHaveBeenCalledTimes(1);
    resolve({ author: AUTHOR });
    expect(await Promise.all([first, second])).toEqual([{ state: "completed", author: AUTHOR }, { state: "completed", author: AUTHOR }]);
    expect(complete.hasPending()).toBe(false);
    const retryBrowser = browser();
    const retry = new AuthorCompletion({ post } as unknown as ApiClient, () => NOW, retryBrowser.value);
    await expect(retry.complete(A, "a")).rejects.toThrow("Try later");
    expect(retry.hasPending()).toBe(true);
  });

  it("serializes a wallet switch and retries with the newly selected wallet's bearer", async () => {
    const { value } = browser();
    let reject!: (error: ApiError) => void;
    const post = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce({ author: AUTHOR });
    const completion = new AuthorCompletion({ post } as unknown as ApiClient, () => NOW, value);
    const wrong = completion.complete(B, "bearer-for-b");
    const correct = completion.complete(A, "bearer-for-a");
    expect(post).toHaveBeenCalledTimes(1);
    reject(new ApiError(403, "x_oauth_completion_wallet_mismatch", "Wrong wallet"));
    expect(await wrong).toEqual({ state: "waiting" });
    expect(await correct).toEqual({ state: "completed", author: AUTHOR });
    expect(post.mock.calls.map((call) => call[2])).toEqual([{ token: "bearer-for-b" }, { token: "bearer-for-a" }]);
    expect(completion.hasPending()).toBe(false);
  });
});
