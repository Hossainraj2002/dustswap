/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EMPTY_DRAFT, type CreateDraft } from "@/lib/create/draft";
import { TweetImportPanel } from "./TweetImportPanel";

vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: { kind: "preview" } }) }));
afterEach(cleanup);
const source = { postId: "123", url: "https://x.com/alice/status/123", text: "An idea", author: { id: "42", handle: "alice", name: "Alice" } };

describe("restored tweet drafts", () => {
  it("restores the post input after the draft loads without replacing a new link during other edits", () => {
    const empty: CreateDraft = { ...EMPTY_DRAFT, entry: "tweet" };
    const update = vi.fn();
    const page = render(<TweetImportPanel draft={empty} update={update} />);
    const input = screen.getByLabelText("Public X post link") as HTMLInputElement;
    expect(input.value).toBe("");
    const restored = { ...empty, tweet: { source, authorShareBps: 5000 } };
    page.rerender(<TweetImportPanel draft={restored} update={update} />);
    expect(input.value).toBe(source.url);
    fireEvent.change(input, { target: { value: "https://x.com/bob/status/456" } });
    page.rerender(<TweetImportPanel draft={{ ...restored, name: "Edited name", tweet: { ...restored.tweet, authorShareBps: 2000 } }} update={update} />);
    expect(input.value).toBe("https://x.com/bob/status/456");
    expect(screen.getByText("Original post by @alice")).toBeDefined();
  });
});
