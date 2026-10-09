/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DRAFT } from "@/lib/create/draft";
import { USDC } from "@/lib/market/quotes";
import { FirstBuyStep } from "./FirstBuyStep";

vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ status: "connected", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) }));
vi.mock("@/lib/market/hooks", () => ({ useQuoteBalance: () => 150 }));
afterEach(cleanup);

const DRAFT = { ...EMPTY_DRAFT, ticker: "TEST", firstBuy: "200", feeBps: 100 };
const ADVISORY = /Buying more than 5% of the supply at launch/;
const shownValue = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe("first-buy supply advisory", () => {
  it("suppresses only the supply advisory for the selected official token, preserving real amounts and costs", () => {
    const props = { draft: DRAFT, update: vi.fn(), quote: USDC, openingFdvUsd: 1_000 };
    const { rerender } = render(<FirstBuyStep {...props} />);
    expect(screen.getByText(ADVISORY)).toBeDefined();
    const numbers = [shownValue("You get"), shownValue("Share of supply"), shownValue("Market cap after")];
    expect(parseFloat(numbers[1]!)).toBeGreaterThan(5);
    expect(screen.getByText("Balance 150 USDC")).toBeDefined();
    expect(screen.getByText("That is more than your USDC balance.")).toBeDefined();
    expect(screen.getByText(/It pays the normal 1% fee/)).toBeDefined();

    rerender(<FirstBuyStep {...props} officialPlatformToken />);
    expect(screen.queryByText(ADVISORY)).toBeNull();
    expect([shownValue("You get"), shownValue("Share of supply"), shownValue("Market cap after")]).toEqual(numbers);
    expect(screen.getByLabelText("Spend").getAttribute("value")).toBe("200");
    expect(screen.getByText("Balance 150 USDC")).toBeDefined();
    expect(screen.getByText("That is more than your USDC balance.")).toBeDefined();
    expect(screen.getByText(/It pays the normal 1% fee/)).toBeDefined();
  });

  it("keeps the normal advisory when only an unverified restored draft flag is present", () => {
    render(<FirstBuyStep draft={{ ...DRAFT, officialPlatformToken: true }} update={vi.fn()} quote={USDC} openingFdvUsd={1_000} />);
    expect(screen.getByText(ADVISORY)).toBeDefined();
  });

  it("does not show the supply advisory for a small ordinary first buy", () => {
    render(<FirstBuyStep draft={{ ...DRAFT, firstBuy: "1" }} update={vi.fn()} quote={USDC} openingFdvUsd={1_000} />);
    expect(screen.queryByText(ADVISORY)).toBeNull();
    expect(shownValue("Share of supply")).toBeDefined();
    expect(screen.queryByText("That is more than your USDC balance.")).toBeNull();
  });

  it("keeps blocking validation errors visible for an official first buy", () => {
    render(<FirstBuyStep draft={DRAFT} update={vi.fn()} quote={USDC} openingFdvUsd={1_000} officialPlatformToken error="Not enough USDC." />);
    expect(screen.getByRole("alert").textContent).toBe("Not enough USDC.");
    expect(screen.getByLabelText("Spend").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByText(ADVISORY)).toBeNull();
  });
});
