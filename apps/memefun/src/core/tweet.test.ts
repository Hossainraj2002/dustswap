import { describe, expect, it } from "vitest";
import { normalizeTweetResponse, parseTweetUrl, safeTweetMediaUrl, suggestTweetIdentity, validateAuthorShareBps, validXId } from "./tweet";
import { validateName, validateTicker } from "./validation";

const id = "18446744073709551000";
const post = (extra: Record<string, unknown> = {}) => ({ status: "success", data: { id, text: "The tiny moon cat is back! #MoonCat", author: { id: "44196397", userName: "moon_cat", name: "Moon Cat" }, ...extra } });

describe("public X post parsing", () => {
  it.each([`https://x.com/moon_cat/status/${id}?s=20`, `https://twitter.com/moon_cat/status/${id}/photo/1`, `x.com/i/web/status/${id}`, `https://mobile.twitter.com/i/status/${id}/`])("canonicalizes %s without a network request", (url) => {
    expect(parseTweetUrl(url)).toEqual({ postId: id, url: `https://x.com/i/status/${id}` });
  });
  it.each(["https://x.com.evil.test/a/status/123", "https://evil.test/x.com/a/status/123", "https://x.com@127.0.0.1/a/status/123", "http://x.com/a/status/123", "https://x.com:8443/a/status/123", "https://x.com/a/status/0", "https://x.com/a/status/00123", "https://x.com/a/status/18446744073709551616", "https://x.com/a", "https://x.com/a/status/123/../../admin", "javascript:alert(1)"]) ("rejects %s", (url) => {
    expect(() => parseTweetUrl(url)).toThrow();
  });
  it("preserves exact snowflakes and validates the author share range", () => {
    expect(validXId(id)).toBe(true);
    expect(validXId(Number(id))).toBe(false);
    expect(validXId("18446744073709551616")).toBe(false);
    expect([2_000, 5_000, 10_000].every(validateAuthorShareBps)).toBe(true);
    expect([1_999, 10_001, 5_000.1, "5000", NaN].some(validateAuthorShareBps)).toBe(false);
  });
});

describe("provider trust boundaries", () => {
  it("uses the fetched author ID and own images, never URL handles or quoted-post images", () => {
    const result = normalizeTweetResponse(post({ media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/moon.jpg", id_str: "10" }], quoted_tweet: { author: { id: "2" }, media: [{ url: "https://pbs.twimg.com/media/other.jpg" }] } }), id);
    expect(result.author.id).toBe("44196397");
    expect(result.url).toBe(`https://x.com/moon_cat/status/${id}`);
    expect(result.photos).toEqual([{ id: "10", url: "https://pbs.twimg.com/media/moon.jpg" }]);
    expect(result.authorFeesSupported).toBe(false);
  });
  it("rejects mismatched IDs, private posts and missing author proof", () => {
    expect(() => normalizeTweetResponse(post({ id: "123" }), id)).toThrow();
    expect(() => normalizeTweetResponse(post({ author: { id: 44196397, userName: "moon_cat" } }), id)).toThrow();
    expect(() => normalizeTweetResponse(post({ author: { id: "1", userName: "moon_cat", protected: true } }), id)).toThrow();
    expect(() => normalizeTweetResponse({ status: "error", data: post().data }, id)).toThrow();
  });
  it("filters external media, duplicates and limits selection to four", () => {
    const media = [{ url: "https://127.0.0.1/private.jpg" }, { url: "https://pbs.twimg.com.evil.test/a.jpg" }, ...Array.from({ length: 6 }, (_, i) => ({ url: `https://pbs.twimg.com/media/${i}.jpg` })), { url: "https://pbs.twimg.com/media/0.jpg" }];
    const result = normalizeTweetResponse(post({ media }), id);
    expect(result.photos).toHaveLength(4);
    expect(result.photos.every(photo => photo.url.startsWith("https://pbs.twimg.com/media/"))).toBe(true);
    expect(safeTweetMediaUrl("https://user:password@pbs.twimg.com/media/a.jpg")).toBeUndefined();
    expect(safeTweetMediaUrl("http://pbs.twimg.com/media/a.jpg")).toBeUndefined();
  });
});

describe("zero-credit naming suggestions", () => {
  it.each(["#MoonCat tiny cat, big moon", "$MOON tiny moon cat", "আমাদের ছোট বিড়াল", "https://example.com @friend", "\u202eHidden\u0000 words", "", "a ".repeat(500), "🐱🚀 #VeryLongHashtagNameForTheMoonCatLaunch"]) ("always returns editable valid form fields for %s", (text) => {
    const result = suggestTweetIdentity(text, id);
    expect(validateName(result.suggestedName).ok).toBe(true);
    expect(validateTicker(result.suggestedTicker).ok).toBe(true);
    expect(suggestTweetIdentity(text, id)).toEqual(result);
  });
  it("prefers a real cashtag for the ticker", () => {
    expect(suggestTweetIdentity("$MOON meet the #MoonCat", id)).toEqual({ suggestedName: "MoonCat", suggestedTicker: "MOON" });
  });
});
