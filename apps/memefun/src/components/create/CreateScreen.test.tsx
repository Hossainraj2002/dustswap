/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { EMPTY_DRAFT } from "@/lib/create/draft";
import { ETH, USDC } from "@/lib/market/quotes";
import { TxError } from "@/lib/market/Market";
import { PLATFORM_TOKEN_LAUNCH_AT, PLATFORM_TOKEN_LAUNCHER, type PlatformTokenInfo } from "@/lib/platform-token/config";
import { CreateScreen } from "./CreateScreen";

const view = vi.hoisted(() => ({ balance: 10, launch: vi.fn(), marketKind: "preview", walletAddress: "0x00000000000000000000000000000000000000aa",
  preview: true, platformAvailable: false, showAnnouncement: false, platformInfo: null as PlatformTokenInfo | null }));
vi.mock("@/lib/hooks", () => ({ useIsRegularWidth: () => true }));
vi.mock("@/lib/market/hooks", () => ({
  useLaunchSettings: () => DEFAULT_SETTINGS,
  useQuoteAssets: () => [ETH, USDC],
  usePairCatalog: () => ({ quotes: [ETH, USDC] }),
  useQuoteBalance: () => view.balance,
  useCoins: () => ({ coins: [] }),
}));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: { kind: view.marketKind, launch: view.launch } }) }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ status: "connected", address: view.walletAddress, onBase: true }) }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ txOutcome: "success", stocksRestricted: false, preview: view.preview }) }));
vi.mock("@/lib/platform-token/usePlatformToken", () => ({ usePlatformToken: () => ({ info: view.platformInfo, available: view.platformAvailable, showAnnouncement: view.showAnnouncement }) }));
vi.mock("./FeesStep", () => ({ FeesStep: () => <p>Fee controls</p> }));
vi.mock("@/components/shell/PageHeader", () => ({ PageHeader: () => <h1>Create a coin</h1> }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

beforeEach(() => {
  view.balance = 10; view.launch.mockReset();
  view.marketKind = "preview"; view.walletAddress = "0x00000000000000000000000000000000000000aa"; view.preview = true;
  view.platformAvailable = false; view.showAnnouncement = false; view.platformInfo = null;
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

function enableOfficialSelection() {
  view.marketKind = "live"; view.preview = false; view.walletAddress = PLATFORM_TOKEN_LAUNCHER;
  view.platformAvailable = true; view.showAnnouncement = true;
  view.platformInfo = { enabled: true, launchAt: PLATFORM_TOKEN_LAUNCH_AT, launcher: PLATFORM_TOKEN_LAUNCHER, tokenAddress: null };
  view.launch.mockImplementation(() => new Promise(() => {}));
}
function restoreOfficialDraft() {
  sessionStorage.setItem("memefun:create-draft", JSON.stringify({ ...JSON.parse(sessionStorage.getItem("memefun:create-draft")!), officialPlatformToken: true }));
}

describe("official token launch selection", () => {
  it("lets the designated wallet select the official launch and passes that choice to the market", () => {
    enableOfficialSelection();
    render(<CreateScreen />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Official platform token/ }));
    expect(JSON.parse(sessionStorage.getItem("memefun:create-draft")!).officialPlatformToken).toBe(true);
    review();
    expect(screen.getByText("Official platform token")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Launch TEST" }));
    expect(view.launch.mock.calls[0]?.[1].officialPlatformToken).toBe(true);
  });

  it("does not offer official selection to an ordinary wallet", () => {
    enableOfficialSelection(); view.walletAddress = "0x00000000000000000000000000000000000000aa";
    render(<CreateScreen />);
    expect(screen.queryByRole("checkbox", { name: /Official platform token/ })).toBeNull();
  });

  it("clears a restored official flag after hydration for a different connected wallet", () => {
    enableOfficialSelection(); restoreOfficialDraft();
    view.walletAddress = "0x00000000000000000000000000000000000000aa";
    render(<CreateScreen />);
    expect(screen.queryByRole("checkbox", { name: /Official platform token/ })).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("memefun:create-draft")!).officialPlatformToken).toBe(false);
    review();
    fireEvent.click(screen.getByRole("button", { name: "Launch TEST" }));
    expect(view.launch.mock.calls[0]?.[1].officialPlatformToken).toBe(false);
  });

  it.each(["pinned", "unavailable"] as const)("lets the designated wallet recover a restored official draft after selection becomes %s", (reason) => {
    enableOfficialSelection(); restoreOfficialDraft();
    if (reason === "pinned") view.platformInfo = { enabled: true, launchAt: PLATFORM_TOKEN_LAUNCH_AT, launcher: PLATFORM_TOKEN_LAUNCHER, tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    else view.platformAvailable = false;
    render(<CreateScreen />);
    const checkbox = screen.getByRole("checkbox", { name: /Official platform token/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
    expect(screen.getByText("Official selection is unavailable. Untick this option to create a regular token.")).toBeDefined();
    fireEvent.click(checkbox);
    expect(JSON.parse(sessionStorage.getItem("memefun:create-draft")!).officialPlatformToken).toBe(false);
    review();
    fireEvent.click(screen.getByRole("button", { name: "Launch TEST" }));
    expect(view.launch.mock.calls[0]?.[1].officialPlatformToken).toBe(false);
  });
});
