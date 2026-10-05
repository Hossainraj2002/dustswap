/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Coin } from "@/lib/market/types";
import type { AuthorReward } from "@/lib/create/tweet";
import { PreviewMarket } from "@/lib/preview/engine";
import { AuthorRewardsScreen } from "./AuthorRewardsScreen";

const view = vi.hoisted(() => ({ wallet: "0x00000000000000000000000000000000000000dd", coins: [] as Coin[], balances: vi.fn(), claim: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/market/hooks", () => ({ useCoins: () => ({ coins: view.coins }), useCoin: () => ({ coin: undefined }) }));
vi.mock("@/lib/market/MarketProvider", () => {
  const market = { kind: "preview", getAuthorSession: () => null, getAuthorRewards: () => [],
    isAuthorTreasury: (user?: string) => user?.toLowerCase() === "0x00000000000000000000000000000000000000dd",
    getTreasuryAuthorRewards: (user: string, coin: string) => view.balances(user, coin),
    claimTreasuryAuthorRewards: (user: string, coin: string, poolId: string) => view.claim(user, coin, poolId) };
  return { useMarket: () => ({ market }) };
});
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ status: "connected", address: view.wallet, onBase: true }) }));
vi.mock("@/components/shell/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));

const TREASURY = "0x00000000000000000000000000000000000000dd";
const AUTHOR = "0x00000000000000000000000000000000000000bb";
const COIN = "0x0000000000000000000000000000000000000123" as const;
const POOL = `0x${"1".repeat(64)}` as const;
const base = new PreviewMarket({ now: Date.UTC(2026, 9, 4), seed: 1 }).listCoins()[0]!;
const coin: Coin = { ...base, address: COIN, name: "Idea", symbol: "IDEA", image: "", tweet: { postId: "123", authorXUserId: "42", authorShareBps: 5000, treasuryUnlockAt: 1 } };
const reward: AuthorReward = { coin: COIN, poolId: POOL, currency: "0x0000000000000000000000000000000000000000", quoteSymbol: "ETH", amountQuote: 0.1, amountUsd: 300, amountRaw: "100000000000000000" };
beforeEach(() => { view.wallet = TREASURY; view.coins = [coin]; view.balances.mockReset(); view.claim.mockReset(); });
afterEach(cleanup);

describe("treasury author withdrawal controls", () => {
  it("loads balances only on request, gates withdrawals by the unlock, and refreshes the selected pool after a fixed-recipient claim", async () => {
    view.coins = [{ ...coin, tweet: { ...coin.tweet!, treasuryUnlockAt: Date.now() + 86_400_000 } }];
    view.balances.mockResolvedValueOnce([reward]).mockResolvedValueOnce([{ ...reward, amountQuote: 0, amountRaw: "0" }]);
    view.claim.mockResolvedValue(`0x${"2".repeat(64)}`);
    const page = render(<AuthorRewardsScreen />);
    expect(view.balances).not.toHaveBeenCalled();
    expect(screen.getAllByRole("region", { name: "Reward terms" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check unpaid balances" }));
    const withdraw = await screen.findByRole("button", { name: "Withdraw ETH" }) as HTMLButtonElement;
    expect(withdraw.disabled).toBe(true);
    expect(view.balances).toHaveBeenCalledWith(TREASURY, COIN);
    view.coins = [coin]; page.rerender(<AuthorRewardsScreen />);
    expect(withdraw.disabled).toBe(false);
    fireEvent.click(withdraw);
    await waitFor(() => expect(view.claim).toHaveBeenCalledWith(TREASURY, COIN, POOL));
    await waitFor(() => expect(view.balances).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(withdraw.disabled).toBe(true));
    expect(screen.queryByLabelText("Reward payout wallet")).toBeNull();
    view.wallet = AUTHOR; page.rerender(<AuthorRewardsScreen />);
    expect(screen.queryByRole("region", { name: "Treasury withdrawals" })).toBeNull();
    view.wallet = TREASURY; page.rerender(<AuthorRewardsScreen />);
    expect(screen.queryByRole("button", { name: "Withdraw ETH" })).toBeNull();
    expect(view.balances).toHaveBeenCalledTimes(2);
  });
  it("drops an old wallet's pending balance response and does not restore it when the treasury reconnects", async () => {
    let complete!: (rewards: AuthorReward[]) => void;
    view.balances.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const page = render(<AuthorRewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Check unpaid balances" }));
    expect(view.balances).toHaveBeenCalledTimes(1);
    view.wallet = AUTHOR; page.rerender(<AuthorRewardsScreen />);
    expect(screen.queryByRole("region", { name: "Treasury withdrawals" })).toBeNull();
    view.wallet = TREASURY; page.rerender(<AuthorRewardsScreen />);
    await act(async () => { complete([reward]); });
    expect(screen.queryByRole("button", { name: "Withdraw ETH" })).toBeNull();
    expect(view.balances).toHaveBeenCalledTimes(1);
    view.balances.mockResolvedValueOnce([reward]);
    fireEvent.click(screen.getByRole("button", { name: "Check unpaid balances" }));
    expect(await screen.findByRole("button", { name: "Withdraw ETH" })).toBeDefined();
    expect(view.balances).toHaveBeenCalledTimes(2);
  });
});
