/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { EMPTY_DRAFT } from "@/lib/create/draft";
import { ETH, USDC } from "@/lib/market/quotes";
import { TxError } from "@/lib/market/Market";
import { CreateScreen } from "./CreateScreen";

const view = vi.hoisted(() => ({ balance: 10, launch: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useIsRegularWidth: () => true }));
vi.mock("@/lib/market/hooks", () => ({
  useLaunchSettings: () => DEFAULT_SETTINGS,
  useQuoteAssets: () => [ETH, USDC],
  usePairCatalog: () => ({ quotes: [ETH, USDC] }),
  useQuoteBalance: () => view.balance,
  useCoins: () => ({ coins: [] }),
}));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: { kind: "preview", launch: view.launch } }) }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ status: "connected", address: "0x00000000000000000000000000000000000000aa", onBase: true }) }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ txOutcome: "success", stocksRestricted: false, preview: true }) }));
vi.mock("./FeesStep", () => ({ FeesStep: () => <p>Fee controls</p> }));
vi.mock("@/components/shell/PageHeader", () => ({ PageHeader: () => <h1>Create a coin</h1> }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

beforeEach(() => {
  view.balance = 10; view.launch.mockReset();
  sessionStorage.clear();
  sessionStorage.setItem("memefun:create-draft", JSON.stringify({ ...EMPTY_DRAFT, image: "data:image/png;base64,eA==", name: "Test", ticker: "TEST",
    launchMode: "multi", quoteId: ETH.address, quoteIds: [ETH.address, USDC.address], firstBuyQuoteId: USDC.address, firstBuy: "1" }));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
function review() {
  for (let index = 0; index < 4; index++) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText("Review and launch")).toBeDefined();
}

describe("launch review validation", () => {
  it("rechecks a balance changed after reaching review and shows the first-buy error", () => {
    const page = render(<CreateScreen />); review();
    view.balance = 0.5; page.rerender(<CreateScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Launch TEST" }));
    expect(view.launch).not.toHaveBeenCalled();
    expect(screen.getByText("Make the first buy")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe("Not enough USDC.");
    expect(screen.getByLabelText("Spend").getAttribute("aria-invalid")).toBe("true");
  });
  it.each([".", "0.0000001"])("rechecks %s when a user jumps from an edited first buy back to review", (amount) => {
    render(<CreateScreen />); review();
    fireEvent.click(screen.getByRole("button", { name: "First buy, completed. Edit" }));
    fireEvent.change(screen.getByLabelText("Spend"), { target: { value: amount } });
    fireEvent.click(screen.getByRole("button", { name: "Review, completed. Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Launch TEST" }));
    expect(view.launch).not.toHaveBeenCalled();
    expect(screen.getByText("Make the first buy")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toMatch(amount === "." ? /valid amount/ : /6 decimal places/);
  });
});

describe("pending launch navigation", () => {
  it.each(["rejected", "reverted"] as const)("locks draft navigation until a %s launch finishes, then permits editing and continuing", async (kind) => {
    let reject!: (error: Error) => void;
    view.launch.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<CreateScreen />); review();
    const saved = sessionStorage.getItem("memefun:create-draft");
    fireEvent.click(screen.getByRole("button", { name: "Launch TEST" }));
    expect(view.launch).toHaveBeenCalledTimes(1);
    const coinStep = screen.getByRole("button", { name: "Coin, completed. Edit" });
    const back = screen.getByRole("button", { name: "Back" });
    expect(coinStep.matches(":disabled")).toBe(true);
    expect(back.matches(":disabled")).toBe(true);
    fireEvent.click(coinStep); fireEvent.click(back);
    expect(screen.getByText("Review and launch")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(sessionStorage.getItem("memefun:create-draft")).toBe(saved);
    await act(async () => reject(new TxError("Test launch stopped", kind)));
    expect(coinStep.matches(":disabled")).toBe(false);
    expect(back.matches(":disabled")).toBe(false);
    fireEvent.click(coinStep);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited after launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Choose its pairs")).toBeDefined();
    expect(JSON.parse(sessionStorage.getItem("memefun:create-draft")!).name).toBe("Edited after launch");
  });
});
