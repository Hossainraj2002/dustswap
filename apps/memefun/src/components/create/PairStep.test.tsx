/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { QuoteAsset } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { EMPTY_DRAFT, type CreateDraft } from "@/lib/create/draft";
import { ETH } from "@/lib/market/quotes";
import { PairStep } from "./PairStep";

const view = vi.hoisted(() => ({ quotes: [] as QuoteAsset[], sort: "", restricted: false }));
vi.mock("@/lib/market/hooks", () => ({ usePairCatalog: (sort: string) => { view.sort = sort; return { quotes: view.quotes, notice: "" }; } }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ stocksRestricted: view.restricted }) }));
afterEach(() => { cleanup(); view.restricted = false; });
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
