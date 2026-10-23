import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";

describe("authenticated author reads", () => {
  it("sends a wallet session only on explicit authenticated reads", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ author: null }));
    const api = createApi("https://example.com", request);
    await api.get("/v1/author/me", { token: "private-session" });
    await api.get("/v1/coins");
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer private-session");
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
  });
});

describe("cold-wake GET retries", () => {
  const now = new Date("2026-10-22T15:00:00Z");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("retries only gateway responses with bounded backoff and keeps explicit authentication", async () => {
    const times: number[] = [];
    const statuses = [502, 503, 504, 200];
    const request = vi.fn<typeof fetch>(async () => {
      times.push(Date.now() - now.getTime());
      const status = statuses.shift()!;
      return status === 200 ? Response.json({ coins: [] }) : new Response("Waking origin", { status });
    });
    const result = createApi("https://example.com", request).get("/v1/coins", { token: "session", adminToken: "admin" });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(result).resolves.toEqual({ coins: [] });
    expect(times).toEqual([0, 1_000, 3_000, 6_000]);
    for (const [url, options] of request.mock.calls) {
      expect(url).toBe("https://example.com/v1/coins");
      expect(options?.method).toBeUndefined();
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer session");
      expect(new Headers(options?.headers).get("x-admin-token")).toBe("admin");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { value: "2", delay: 2_000 },
    { value: new Date(now.getTime() + 3_000).toUTCString(), delay: 3_000 },
    { value: "120", delay: 5_000 },
    { value: "not-a-date", delay: 1_000 },
  ])("honors Retry-After $value within the five-second cap", async ({ value, delay }) => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503, headers: { "retry-after": value } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const result = createApi("https://example.com", request).get("/v1/health");
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after three retries with a friendly error for an HTML gateway response", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("<html>Origin waking</html>", { status: 503 }));
    const result = createApi("https://example.com", request).get("/v1/coins").catch(error => error);
    await vi.advanceTimersByTimeAsync(6_000);
    const error = await result;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: "server_warming", message: "MemeFun is waking up. Please try again in a moment." });
    expect(request).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a backend's structured business error without retrying", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "unavailable", message: "Feed is unavailable", details: { feed: "ETH" } } }, { status: 503 }));
    const result = createApi("https://example.com", request).get("/v1/quotes").catch(error => error);
    expect(await result).toMatchObject({ status: 503, code: "unavailable", message: "Feed is unavailable", details: { feed: "ETH" } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["api_warming", "api_busy", "api_unavailable", "api_stopping"])("recognizes the explicit gateway code %s", async code => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code, message: "Origin is waking" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ coins: [] }));
    const result = createApi("https://example.com", request).get("/v1/coins");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ coins: [] });
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat a warming code on a non-gateway HTTP status as retryable", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "api_busy", message: "Rate limit" } }, { status: 429 }));
    await expect(createApi("https://example.com", request).get("/v1/coins")).rejects.toMatchObject({ status: 429, code: "api_busy" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 429, 500])("does not retry HTTP %s", async status => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "original", message: "Original rejection" } }, { status }));
    await expect(createApi("https://example.com", request).get("/v1/coins")).rejects.toMatchObject({ status, code: "original", message: "Original rejection" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry network errors", async () => {
    const failure = new TypeError("Network unavailable");
    const request = vi.fn<typeof fetch>().mockRejectedValue(failure);
    await expect(createApi("https://example.com", request).get("/v1/coins")).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a request for an already-aborted caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const request = vi.fn<typeof fetch>();
    await expect(createApi("https://example.com", request).get("/v1/coins", { signal: caller.signal })).rejects.toBe(caller.signal.reason);
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an in-flight request and disposes timers and caller listeners", async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    let incoming: AbortSignal | undefined;
    const request = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      incoming = options?.signal ?? undefined;
      incoming?.addEventListener("abort", () => reject(incoming?.reason), { once: true });
    }));
    const result = createApi("https://example.com", request).get("/v1/coins", { signal: caller.signal }).catch(error => error);
    caller.abort();
    expect(await result).toBe(caller.signal.reason);
    expect(incoming?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a retry backoff immediately without sending another request", async () => {
    const caller = new AbortController();
    const request = vi.fn<typeof fetch>(async () => new Response("Origin waking", { status: 503 }));
    const result = createApi("https://example.com", request).get("/v1/coins", { signal: caller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    caller.abort();
    expect(await result).toBe(caller.signal.reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish a response body that completed after the caller aborted", async () => {
    const caller = new AbortController();
    const response = Response.json({ coins: [] });
    let release!: (text: string) => void;
    vi.spyOn(response, "text").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = createApi("https://example.com", request).get("/v1/coins", { signal: caller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    release('{"coins":[]}');
    expect(await result).toBe(caller.signal.reason);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits each fetch to fifteen seconds without retrying timeouts", async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const result = createApi("https://example.com", request).get("/v1/coins").catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ name: "TimeoutError" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps the complete cold-wake sequence at forty-five seconds", async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(new Response("Origin waking", { status: 503 }));
      }, 14_000);
      signal?.addEventListener("abort", abort, { once: true });
    }));
    const result = createApi("https://example.com", request).get("/v1/coins").catch(error => error);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await result).toMatchObject({ name: "TimeoutError" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never retries a POST or file upload and preserves their payloads", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("Origin unavailable", { status: 503 }));
    const api = createApi("https://example.com", request);
    await expect(api.post("/v1/launch-campaign/ticket", { coin: "0x123" }, { token: "session" })).rejects.toMatchObject({ status: 503, code: "http_503" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: '{"coin":"0x123"}' });
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer session");
    await expect(api.upload("/v1/images", new Blob(["image"], { type: "image/png" }), "coin.png", { token: "session" })).rejects.toMatchObject({ status: 503, code: "http_503" });
    expect(request).toHaveBeenCalledTimes(2);
    const options = request.mock.calls[1]?.[1];
    expect(options?.method).toBe("POST");
    expect(options?.body).toBeInstanceOf(FormData);
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer session");
    expect(new Headers(options?.headers).has("content-type")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
