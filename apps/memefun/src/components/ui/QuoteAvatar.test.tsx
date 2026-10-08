/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { USDC } from "@/lib/market/quotes";
import { QuoteAvatar } from "./QuoteAvatar";

afterEach(cleanup);
describe("quote image recovery", () => {
  const stock = { ...USDC, address: "0xb200000000000000000000c2e324d24d7eecd1fb" as const, symbol: "AAPLc", kind: "stock" as const, source: "coinbase" as const, iconUrl: "https://example.com/apple.png" };
  it("uses a bundled real logo after the issuer CDN image fails", () => {
    render(<QuoteAvatar quote={stock} />);
    fireEvent.error(screen.getByRole("img", { name: "AAPLc logo" }));
    expect(screen.getByRole("img", { name: "AAPLc logo" }).getAttribute("src")).toContain("/pair-icons/stocks/");
  });
  it("retries new metadata after old sources fail without using a different token's brand", () => {
    const meme = { ...USDC, address: "0x1111111111111111111111111111111111111111" as const, kind: "token" as const, symbol: "MEME", iconUrl: "https://example.com/old.png" };
    const { rerender } = render(<QuoteAvatar quote={meme} />);
    fireEvent.error(screen.getByRole("img", { name: "MEME logo" }));
    expect(screen.getByRole("img", { name: "MEME logo unavailable" })).toBeDefined();
    rerender(<QuoteAvatar quote={{ ...meme, iconUrl: "https://example.com/new.png" }} />);
    expect(screen.getByRole("img", { name: "MEME logo" }).getAttribute("src")).toBe("https://example.com/new.png");
  });
});
