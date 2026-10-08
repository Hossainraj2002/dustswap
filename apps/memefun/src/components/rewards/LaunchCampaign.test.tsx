// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { LaunchCampaignSummary, LaunchCampaignWalletStatus } from "@/core/campaign";
import { TxError, type TxStage } from "@/lib/market/Market";
import { LaunchCampaignBanner, LaunchCampaignClaimCard } from "./LaunchCampaign";

const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;
const state = vi.hoisted(() => ({
  summary: null as LaunchCampaignSummary | null,
  eligibility: null as LaunchCampaignWalletStatus | null,
  error: false,
  refresh: vi.fn(),
  address: null as `0x${string}` | null,
  connect: vi.fn(),
  claim: vi.fn(),
}));
vi.mock("@/lib/campaign/useLaunchCampaign", () => ({ useLaunchCampaign: () => ({ summary: state.summary, wallet: state.eligibility, error: state.error, refresh: state.refresh }) }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ address: state.address, connect: state.connect }) }));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: { claimLaunchCampaign: state.claim } }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

function summary(overrides: Partial<Extract<LaunchCampaignSummary, { enabled: true }>> = {}): Extract<LaunchCampaignSummary, { enabled: true }> {
  return {
    enabled: true, chainId: 8453, contract: A,
    token: { address: B, name: "Campaign token", symbol: "MFT", decimals: 18 },
    rewardAmountRaw: "1234567890123456789012345678901234567", maxRecipients: 1000,
    claimedCount: 4, qualifiedCount: 7, startBlock: "100", tradeRequiredFromBlock: "0", ...overrides,
  };
}
function status(value: LaunchCampaignWalletStatus["state"], tradeRequired = false): LaunchCampaignWalletStatus {
  return { wallet: A, state: value, tradeRequired, coin: B, launchBlock: "101" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  state.summary = summary();
  state.eligibility = status("eligible");
  state.address = A;
  state.error = false;
  state.refresh.mockReset();
  state.connect.mockReset().mockResolvedValue(undefined);
  state.claim.mockReset().mockResolvedValue(`0x${"12".repeat(32)}`);
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

describe("launch campaign visibility and disclosure", () => {
  it.each([null, { enabled: false } as LaunchCampaignSummary])("renders no banner or claim UI when configuration is %j", config => {
    state.summary = config;
    const view = render(<><LaunchCampaignBanner /><LaunchCampaignClaimCard /></>);
    expect(view.container.innerHTML).toBe("");
  });

  it("formats the exact raw reward without rounding and counts reserved allocations", () => {
    render(<LaunchCampaignBanner />);
    expect(screen.getByRole("heading").textContent).toBe("Launch a token to earn 1234567890123456789.012345678901234567 MFT");
    expect(screen.getByText(/First 1,000 distinct launcher wallets/).textContent).toContain("One reward per wallet · 993 allocations left");
    expect(screen.getByRole("link", { name: "Launch a token" }).getAttribute("href")).toBe("/create");
    expect(screen.queryByText(/then trade|qualifying trade|Trade any/)).toBeNull();
  });

  it("discloses the trade rule only when it is active and preserves earlier cohorts", () => {
    state.summary = summary({ tradeRequiredFromBlock: "200" });
    render(<LaunchCampaignBanner />);
    expect(screen.getByText(/then trade any MemeFun token/).textContent).toContain("Earlier qualifying launches keep their original rules");
  });

  it("does not invite new launches for exhausted allocations even if some remain unclaimed", () => {
    state.summary = summary({ qualifiedCount: 1000, claimedCount: 4 });
    render(<LaunchCampaignBanner />);
    expect(screen.getByRole("heading").textContent).toBe("Launch reward allocations filled");
    expect(screen.getByRole("link", { name: "View rewards" }).getAttribute("href")).toBe("/rewards");
    expect(screen.queryByRole("link", { name: "Launch a token" })).toBeNull();
    expect(screen.getByText(/0 allocations left/)).toBeTruthy();
  });

  it("shows the earlier wallet's launch-only rule after trade requirements activate for new launchers", () => {
    state.summary = summary({ tradeRequiredFromBlock: "200" });
    state.eligibility = { ...status("eligible"), launchBlock: "101", tradeRequired: false };
    render(<LaunchCampaignClaimCard />);
    expect(screen.getByRole("status").textContent).toBe("Your reward is ready to claim to this wallet.");
    expect(screen.queryByText(/then trade|Trade any MemeFun token/)).toBeNull();
  });

  it("does not tell an unqualified wallet that it already has a qualifying launch", () => {
    state.eligibility = { wallet: A, state: "launch_required", tradeRequired: false };
    render(<LaunchCampaignClaimCard />);
    expect(screen.getByRole("status").textContent).toBe("Launch a token during this campaign to qualify.");
    expect(screen.queryByText(/Your qualifying launch/)).toBeNull();
  });
});

describe("launch reward wallet actions", () => {
  it.each([
    ["launch_required", "Launch a token during this campaign to qualify."],
    ["confirming", "Your eligibility will update after the launch is finalized and indexed."],
    ["trade_required", "Your allocation is reserved. Trade any MemeFun token after your launch to unlock it."],
    ["claimed", "This wallet has claimed its campaign reward."],
    ["full", "All 1,000 launch allocations have been reserved."],
  ] as const)("does not submit a claim from %s state", (value, message) => {
    state.eligibility = status(value, value === "trade_required");
    render(<LaunchCampaignClaimCard />);
    expect(screen.getByRole("status").textContent).toBe(message);
    const claim = screen.getByRole("button", { name: "Claim launch reward" }) as HTMLButtonElement;
    expect(claim.disabled).toBe(true);
    fireEvent.click(claim);
    expect(state.claim).not.toHaveBeenCalled();
    if (value === "trade_required") expect(screen.getByRole("link", { name: "Find a token to trade" }).getAttribute("href")).toBe("/");
    if (value === "launch_required") expect(screen.getByRole("link", { name: "Launch a token" }).getAttribute("href")).toBe("/create");
  });

  it("holds the claim button while eligibility is loading or failed", () => {
    state.eligibility = null;
    const view = render(<LaunchCampaignClaimCard />);
    expect(screen.getByRole("status").textContent).toBe("Checking this wallet’s eligibility…");
    expect((screen.getByRole("button", { name: "Claim launch reward" }) as HTMLButtonElement).disabled).toBe(true);
    state.error = true;
    view.rerender(<LaunchCampaignClaimCard />);
    expect(screen.getByRole("status").textContent).toBe("Eligibility could not be loaded. Try refreshing.");
    expect((screen.getByRole("button", { name: "Claim launch reward" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("claims once to the qualifying connected wallet, then refreshes after confirmation", async () => {
    const result = deferred<`0x${string}`>();
    state.claim.mockReturnValue(result.promise);
    render(<LaunchCampaignClaimCard />);
    const claim = screen.getByRole("button", { name: "Claim launch reward" });
    fireEvent.click(claim);
    fireEvent.click(claim);
    expect(state.claim).toHaveBeenCalledTimes(1);
    expect(state.claim).toHaveBeenCalledWith(A, expect.any(Function));
    expect(state.refresh).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Refresh eligibility" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("textbox")).toBeNull();
    result.resolve(`0x${"12".repeat(32)}`);
    await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("Launch reward claimed", expect.any(Object));
  });

  it("reports preparation, wallet confirmation and receipt waiting separately without allowing another claim", async () => {
    let onStage: ((stage: TxStage) => void) | undefined;
    const result = deferred<`0x${string}`>();
    state.claim.mockImplementation((_wallet: string, report?: (stage: TxStage) => void) => { onStage = report; return result.promise; });
    render(<LaunchCampaignClaimCard />);
    fireEvent.click(screen.getByRole("button", { name: "Claim launch reward" }));
    expect((screen.getByRole("button", { name: "Preparing claim" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onStage).toBeTypeOf("function");
    act(() => onStage!("confirm"));
    expect((screen.getByRole("button", { name: "Confirm in your wallet" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => onStage!("pending"));
    const pending = screen.getByRole("button", { name: "Confirming claim" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(state.claim).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => result.resolve(`0x${"12".repeat(32)}`));
    expect((screen.getByRole("button", { name: "Claim launch reward" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps an in-flight claim locked when the user selects another eligible wallet", async () => {
    const result = deferred<`0x${string}`>();
    state.claim.mockReturnValue(result.promise);
    const view = render(<LaunchCampaignClaimCard />);
    fireEvent.click(screen.getByRole("button", { name: "Claim launch reward" }));
    state.address = B;
    state.eligibility = { ...status("eligible"), wallet: B };
    view.rerender(<LaunchCampaignClaimCard />);
    const pending = screen.getByRole("button", { name: "Preparing claim" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(state.claim).toHaveBeenCalledTimes(1);
    expect(state.claim).toHaveBeenCalledWith(A, expect.any(Function));
    await act(async () => result.reject(new TxError("Your selected wallet changed. Check the connected wallet and try again.", "reverted")));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Reward claim did not go through", { description: expect.stringContaining("selected wallet changed") });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Claim launch reward" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refreshes a rejected claim without claiming success or retrying submission", async () => {
    state.claim.mockRejectedValue(new TxError("Request rejected", "rejected"));
    render(<LaunchCampaignClaimCard />);
    fireEvent.click(screen.getByRole("button", { name: "Claim launch reward" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Claim cancelled"));
    expect(state.claim).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows uncertain confirmation errors without automatically resending the transaction", async () => {
    state.claim.mockRejectedValue(new TxError("The transaction was sent but has not confirmed yet. Check your wallet's activity before trying again.", "reverted"));
    render(<LaunchCampaignClaimCard />);
    fireEvent.click(screen.getByRole("button", { name: "Claim launch reward" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Reward claim did not go through", { description: expect.stringContaining("Check your wallet's activity") }));
    expect(state.claim).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("deduplicates wallet connection and reports cancellation", async () => {
    state.address = null;
    state.eligibility = null;
    const connection = deferred<void>();
    state.connect.mockReturnValue(connection.promise);
    render(<LaunchCampaignClaimCard />);
    const button = screen.getByRole("button", { name: "Connect wallet" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(state.connect).toHaveBeenCalledTimes(1);
    connection.reject(new Error("cancelled"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Wallet connection did not complete"));
    expect(state.claim).not.toHaveBeenCalled();
  });
});
