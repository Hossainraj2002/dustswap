import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { EMPTY_DRAFT, migrateDraft, validateFeesStep } from "./draft";
import { authorTreasuryUnlockAt, tweetTextImage, validAuthorShare } from "./tweet";

const source = { postId: "123", url: "https://x.com/alice/status/123", text: "<script>alert('x')</script> & an idea", author: { id: "42", handle: "alice", name: "Alice" } };
describe("tweet creation drafts", () => {
  it("reads the treasury unlock time from new API data or the legacy alias without allowing an unknown early withdrawal", () => {
    expect(authorTreasuryUnlockAt({ treasuryUnlockAt: 200, verifyBy: 100 })).toBe(200);
    expect(authorTreasuryUnlockAt({ verifyBy: 100 })).toBe(100);
    expect(authorTreasuryUnlockAt({})).toBe(Infinity);
    expect(authorTreasuryUnlockAt({ treasuryUnlockAt: Number.NaN, verifyBy: 100 })).toBe(Infinity);
  });
  it("preserves canonical source separately from editable coin metadata and migrates a fixed creator mode", () => {
    const draft = migrateDraft({ ...EMPTY_DRAFT, entry: "tweet", mode: "floor", name: "My editable name", tweet: { source, authorShareBps: 100 } });
    expect(draft.mode).toBe("creator");
    expect(draft.name).toBe("My editable name");
    expect(draft.tweet?.source).toEqual(source);
    expect(draft.tweet?.authorShareBps).toBe(5000);
  });
  it("drops incomplete or mismatched saved attribution instead of launching with an unverified source", () => {
    expect(migrateDraft({ entry: "tweet", tweet: { source: { ...source, postId: "124" }, authorShareBps: 5000 } }).tweet).toBeUndefined();
    expect(migrateDraft({ entry: "tweet", tweet: { source: { ...source, author: { ...source.author, id: "handle" } }, authorShareBps: 5000 } }).tweet).toBeUndefined();
  });
  it("uses a separate 20 to 100 percent author allocation and rejects community modes", () => {
    for (const value of [2000, 5000, 10000]) expect(validAuthorShare(value)).toBe(true);
    for (const value of [1999, 10001, 5000.5, Number.NaN]) expect(validAuthorShare(value)).toBe(false);
    const draft = { ...EMPTY_DRAFT, entry: "tweet" as const, tweet: { source, authorShareBps: 5000 } };
    expect(validateFeesStep(draft, DEFAULT_SETTINGS)).toEqual({});
    expect(validateFeesStep({ ...draft, mode: "holders" }, DEFAULT_SETTINGS).tweet).toBeTruthy();
  });
  it("builds a deterministic text image without executing post markup or using external image services", () => {
    const image = tweetTextImage(source);
    expect(image).toMatch(/^data:image\/svg\+xml/);
    const xml = decodeURIComponent(image.split(",")[1]!);
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).not.toContain("<script>");
    expect(tweetTextImage(source)).toBe(image);
  });
});
