/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { QuoteAsset } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { EMPTY_DRAFT, type CreateDraft } from "@/lib/create/draft";
import { ETH, USDC } from "@/lib/market/quotes";
import { PairStep } from "./PairStep";

const view = vi.hoisted(() => ({ quotes: [] as QuoteAsset[], sort: "", restricted: false, preview: true }));
vi.mock("@/lib/market/hooks", () => ({ usePairCatalog: (sort: string) => { view.sort = sort; return { quotes: view.quotes, notice: "" }; } }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ stocksRestricted: view.restricted, preview: view.preview }) }));
afterEach(() => { cleanup(); view.restricted = false; view.preview = true; });
const tokens: QuoteAsset[] = Array.from({ length: 6 }, (_, i) => ({ address: `0x${(i + 1).toString().padStart(40, "0")}` as const,
  symbol: i < 2 ? "SAME" : `MEME${i}`, name: `Meme ${i}`, decimals: 18, kind: "token", usdPrice: 1, launchable: true, registered: true }));
function Editor({ initial = EMPTY_DRAFT, quotes = [ETH, ...tokens] }: { initial?: CreateDraft; quotes?: QuoteAsset[] }) {
  const [draft, setDraft] = useState(initial);
  return <><PairStep draft={draft} update={patch => setDraft(current => ({ ...current, ...patch }))} quotes={quotes} openingFdvUsd={5000} enabledKinds={DEFAULT_SETTINGS.enabledQuoteKinds} /><output aria-label="Draft IDs">{draft.quoteIds.join(",")}</output></>;
}
const option = (quote: QuoteAsset) => screen.getByRole("button", { name: `${quote.symbol} ${quote.address}` });
describe("pair selection", () => {
  it("selects duplicate tickers independently and caps multiple pools at five", () => {
    view.quotes = [ETH, ...tokens];
    render(<Editor />);
    fireEvent.click(screen.getByRole("radio", { name: "Multiple pairs" }));
    tokens.slice(0, 4).forEach(token => fireEvent.click(option(token)));
    expect(screen.getByLabelText("Draft IDs").textContent).toBe([ETH.address, ...tokens.slice(0, 4).map(token => token.address)].join(","));
    expect(option(tokens[4]!).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `Remove SAME ${tokens[0]!.address}` }));
    fireEvent.click(option(tokens[4]!));
    expect(screen.getByLabelText("Draft IDs").textContent).toContain(tokens[1]!.address);
    expect(screen.getByLabelText("Draft IDs").textContent).not.toContain(tokens[0]!.address);
  });
  it("searches an exact address while keeping unavailable stocks visible and disabled", () => {
    const stock = { ...tokens[0]!, address: "0x0000000000000000000000000000000000000099" as const, symbol: "AAPLc", kind: "stock" as const, launchable: false, unavailableReason: "No verified feed" };
    view.quotes = [stock, ...tokens];
    render(<Editor />);
    expect(option(stock).matches(":disabled")).toBe(true);
    expect(screen.getByText("No verified feed")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Search pair assets"), { target: { value: tokens[1]!.address } });
    expect(option(tokens[1]!)).toBeDefined();
    expect(screen.queryByRole("button", { name: `${tokens[0]!.symbol} ${tokens[0]!.address}` })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Established" }));
    expect(view.sort).toBe("oldest");
  });
  it("disables a selected price after it expires instead of silently allowing launch", () => {
    const stale = { ...tokens[0]!, priceUpdatedAt: Date.now() - 120_000, priceMaxAgeSec: 60 };
    view.quotes = [stale];
    render(<Editor quotes={[ETH, stale]} />);
    expect(option(stale).matches(":disabled")).toBe(true);
    expect(screen.getByText("Waiting for a fresh verified price")).toBeDefined();
  });
});

describe("pair logos and official stock inventory", () => {
  it("renders native, stable, stock and meme token logos", () => {
    const stock = { ...tokens[0]!, kind: "stock" as const, source: "coinbase" as const, symbol: "AAPLc", iconUrl: "https://metadata.coinbase.com/equity_icons/AAPL.png" };
    const meme = { ...tokens[1]!, iconUrl: "https://example.com/meme.png" };
    view.quotes = [ETH, USDC, stock, meme];
    render(<Editor quotes={[ETH, USDC, stock, meme]} />);
    expect(option(ETH).querySelector("img")?.getAttribute("src")).toBe("/pair-icons/eth.svg");
    expect(option(USDC).querySelector("img")?.getAttribute("src")).toBe("/pair-icons/usdc.svg");
    expect(option(stock).querySelector("img")?.getAttribute("src")).toBe(stock.iconUrl);
    expect(option(meme).querySelector("img")?.getAttribute("src")).toBe(meme.iconUrl);
  });
  it("retains catalog logos and issuer labels in selected pool badges", () => {
    const registryStock = { ...tokens[0]!, address: "0xb200000000000000000000c2e324d24d7eecd1fb" as const,
      kind: "stock" as const, source: "registry" as const, symbol: "OLD", name: "Old stock label" };
    const catalogStock = { ...registryStock, source: "coinbase" as const, symbol: "AAPLc", name: "Apple Inc.",
      iconUrl: "https://metadata.coinbase.com/equity_icons/AAPL.png" };
    const registryMeme = tokens[1]!;
    const catalogMeme = { ...registryMeme, iconUrl: "https://example.com/meme.png" };
    view.quotes = [catalogStock, catalogMeme];
    render(<Editor quotes={[ETH, registryStock, registryMeme]} />);
    fireEvent.click(screen.getByRole("radio", { name: "Multiple pairs" }));
    fireEvent.click(option(catalogStock));
    fireEvent.click(option(catalogMeme));
    const stockBadge = screen.getByRole("button", { name: `Remove AAPLc ${registryStock.address}` });
    const memeBadge = screen.getByRole("button", { name: `Remove SAME ${registryMeme.address}` });
    expect(stockBadge.querySelector("img")?.getAttribute("src")).toBe(catalogStock.iconUrl);
    expect(memeBadge.querySelector("img")?.getAttribute("src")).toBe(catalogMeme.iconUrl);
    expect(screen.getByLabelText("Draft IDs").textContent).toBe([ETH.address, registryStock.address, registryMeme.address].join(","));
  });
  it("shows only issuer-verified stocks on live Base, including locked stocks", () => {
    const official = { ...tokens[0]!, kind: "stock" as const, source: "coinbase" as const, symbol: "AAPLc", launchable: false, unavailableReason: "Issuer paused" };
    const unverified = { ...tokens[1]!, kind: "stock" as const, source: "registry" as const, symbol: "FAKEc" };
    view.preview = false; view.quotes = [official, unverified];
    render(<Editor quotes={[ETH, official, unverified]} />);
    expect(option(official).matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: unverified.symbol + " " + unverified.address })).toBeNull();
  });
});
