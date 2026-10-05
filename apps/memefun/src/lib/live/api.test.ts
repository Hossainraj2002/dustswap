import { describe, expect, it, vi } from "vitest";
import { createApi } from "./api";

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
