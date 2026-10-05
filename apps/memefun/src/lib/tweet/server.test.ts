import { describe, expect, it, vi } from "vitest";
import { boundedBytes, createTweetService } from "./server";

const postId = "2019264360682778716";
const url = `https://x.com/real_author/status/${postId}`;
const fixture = (id = postId) => ({ status: "success", data: { id, text: "#MoonCat is here", author: { id: "44196397", userName: "real_author", name: "Real Author" }, media: [] } });

describe("server X imports", () => {
  it("uses only the fixed GetX endpoint, keeps the key out of the result and coalesces concurrent reads", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(fixture()));
    const service = createTweetService({ key: () => "private-test-key", fetch: request });
    const results = await Promise.all([service.importTweet(url), service.importTweet(url + "?utm_source=test"), service.importTweet(url)]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(`https://api.getxapi.com/twitter/tweet/detail?id=${postId}`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer private-test-key" } });
    expect(results[0]).toEqual(results[2]);
    expect(JSON.stringify(results)).not.toContain("private-test-key");
    await service.importTweet(url);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects arbitrary URLs before network access and fails closed without a key", async () => {
    const request = vi.fn<typeof fetch>();
    const service = createTweetService({ key: () => undefined, fetch: request });
    await expect(service.importTweet("https://127.0.0.1/private")).rejects.toMatchObject({ status: 400 });
    await expect(service.importTweet(url)).rejects.toMatchObject({ status: 503, code: "tweet_import_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });
  it("reserves a daily budget before concurrent calls and resets only the UTC day", async () => {
    let now = Date.UTC(2026, 9, 4, 12);
    const request = vi.fn<typeof fetch>(async (input) => Response.json(fixture(new URL(String(input)).searchParams.get("id")!)));
    const service = createTweetService({ key: () => "key", fetch: request, dailyLimit: 1, now: () => now });
    await service.importTweet(url);
    await expect(service.importTweet("https://x.com/author/status/2")).rejects.toMatchObject({ status: 429 });
    now += 24 * 60 * 60 * 1_000;
    await expect(service.importTweet("https://x.com/author/status/2")).resolves.toMatchObject({ postId: "2" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("counts failures toward spending and does not disclose upstream errors", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: "private-test-key debug detail" }, { status: 401 }));
    const service = createTweetService({ key: () => "private-test-key", fetch: request, dailyLimit: 1 });
    await expect(service.importTweet(url)).rejects.toThrow("The post is unavailable");
    await expect(service.importTweet(url)).rejects.toMatchObject({ status: 429 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("bounds streamed responses regardless of content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.enqueue(new Uint8Array(11)); controller.close(); } });
    await expect(boundedBytes(new Response(stream), 20)).rejects.toMatchObject({ status: 422 });
    await expect(boundedBytes(new Response("abc"), 20)).resolves.toEqual(new TextEncoder().encode("abc"));
  });
});

describe("X image proxy", () => {
  it("never sends provider credentials to media hosts and verifies the image type", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } }));
    const service = createTweetService({ key: () => "secret", fetch: request });
    await expect(service.image("https://pbs.twimg.com/media/photo.jpg")).resolves.toMatchObject({ type: "image/jpeg" });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    expect(request.mock.calls[0]?.[1]).toHaveProperty("redirect", "error");
  });
  it("rejects SSRF, scripts, spoofed image bytes and oversized media", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("<script>private</script>", { headers: { "content-type": "image/png" } }));
    const service = createTweetService({ key: () => "secret", fetch: request });
    await expect(service.image("https://pbs.twimg.com.evil.test/private")).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
    await expect(service.image("https://pbs.twimg.com/media/photo.jpg")).rejects.toMatchObject({ code: "image_invalid" });
    const big = createTweetService({ key: () => "secret", fetch: async () => new Response("x", { headers: { "content-type": "image/jpeg", "content-length": "999999999" } }) });
    await expect(big.image("https://pbs.twimg.com/media/photo.jpg")).rejects.toMatchObject({ code: "too_large" });
  });
});
