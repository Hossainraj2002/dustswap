// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Claimable } from "@/lib/market/types";
import { RewardsScreen } from "./RewardsScreen";

const state = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  claims: [] as Claimable[],
  market: { claim: vi.fn() },
}));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ status: "connected", address: state.address }) }));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: state.market }) }));
vi.mock("@/lib/market/hooks", () => ({ useClaimables: () => state.claims, useCoins: () => ({ ready: true, coins: [] }) }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ txOutcome: "ok", preview: false }) }));
vi.mock("@/components/shell/PageHeader", () => ({ PageHeader: () => <h1>Rewards</h1> }));
vi.mock("@/components/shell/WalletButton", () => ({ ConnectHint: () => <p>Connect wallet</p> }));
vi.mock("@/components/coin/CoinBits", () => ({ UsdFlow: ({ value }: { value: number }) => <span>{value}</span> }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;
const PAYOUT = "0x3333333333333333333333333333333333333333" as const;
const earned = (kind: Claimable["kind"]): Claimable => ({
  coin: "0xb200000000000000000000000000000000000001", kind, amountQuote: 1,
  quoteSymbol: "ETH", amountUsd: 2_500,
});

beforeEach(() => {
  state.address = A;
  state.claims = [earned("creator")];
  state.market.claim.mockReset().mockResolvedValue("0xconfirmed");
  vi.mocked(toast.success).mockClear();
});
afterEach(cleanup);

describe("reward payout wallet", () => {
  it("clears the custom recipient when the connected wallet changes", async () => {
    const view = render(<RewardsScreen />);
    fireEvent.change(screen.getByLabelText("Reward payout wallet"), { target: { value: PAYOUT } });
    expect((screen.getByLabelText("Reward payout wallet") as HTMLInputElement).value).toBe(PAYOUT);
    state.address = B;
    view.rerender(<RewardsScreen />);
    expect((screen.getByLabelText("Reward payout wallet") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Claim all" }));
    await waitFor(() => expect(state.market.claim).toHaveBeenCalledWith(B, state.claims, "ok", undefined, B));
  });

  it("keeps a valid custom recipient while using the same connected wallet", async () => {
    render(<RewardsScreen />);
    fireEvent.change(screen.getByLabelText("Reward payout wallet"), { target: { value: PAYOUT } });
    fireEvent.click(screen.getByRole("button", { name: "Claim all" }));
    await waitFor(() => expect(state.market.claim).toHaveBeenCalledWith(A, state.claims, "ok", undefined, PAYOUT));
  });

  it.each(["holders", "author"] as const)("does not apply custom payout validation to %s-only claims", async kind => {
    state.claims = [earned(kind)];
    render(<RewardsScreen />);
    fireEvent.change(screen.getByLabelText("Reward payout wallet"), { target: { value: "invalid" } });
    expect((screen.getByRole("button", { name: "Claim all" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Claim all" }));
    await waitFor(() => expect(state.market.claim).toHaveBeenCalledWith(A, state.claims, "ok", undefined, A));
  });

  it("still blocks creator and referral claims with an invalid recipient", () => {
    state.claims = [earned("creator"), earned("referral")];
    render(<RewardsScreen />);
    fireEvent.change(screen.getByLabelText("Reward payout wallet"), { target: { value: "invalid" } });
    expect((screen.getByRole("button", { name: "Claim all" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("button", { name: "Claim" }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(state.market.claim).not.toHaveBeenCalled();
  });

  it("keeps different currencies with the same ticker separate in totals and the confirmation", async () => {
    state.claims = [
      { ...earned("creator"), quoteSymbol: "SAME", amountQuote: 1, currency: "0x4444444444444444444444444444444444444444" },
      { ...earned("referral"), quoteSymbol: "SAME", amountQuote: 2, currency: "0x5555555555555555555555555555555555555555" },
    ];
    render(<RewardsScreen />);
    const total = "1 SAME (0x4444...4444), 2 SAME (0x5555...5555)";
    expect(screen.queryByText(total)).not.toBeNull();
    expect(screen.queryByText("3 SAME")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Claim all" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`Claimed ${total}`, expect.any(Object)));
  });

  it("still combines the same currency across claim kinds and address casing", () => {
    state.claims = [
      { ...earned("creator"), quoteSymbol: "SAME", amountQuote: 1, currency: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { ...earned("referral"), quoteSymbol: "SAME", amountQuote: 2, currency: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ];
    render(<RewardsScreen />);
    expect(screen.getByText("3 SAME")).toBeTruthy();
  });
});
