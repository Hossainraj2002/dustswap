// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchCampaignSummary, LaunchCampaignWalletStatus } from "@/core/campaign";
import { useLaunchCampaign } from "./useLaunchCampaign";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const state = vi.hoisted(() => ({
  address: null as `0x${string}` | null,
  market: null as null | { readLaunchCampaign?: ReturnType<typeof vi.fn>; readLaunchCampaignWallet?: ReturnType<typeof vi.fn> },
  freshPreview: false,
  marketRenders: 0,
}));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => {
  if (state.freshPreview && ++state.marketRenders > 10) throw new Error("Campaign hook repeatedly reset an absent preview campaign");
  return { market: state.freshPreview ? {} : state.market };
} }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ address: state.address }) }));

const ACTIVE: LaunchCampaignSummary = {
  enabled: true, chainId: 8453, contract: B,
  token: { address: B, name: "Campaign token", symbol: "MFT", decimals: 18 },
  rewardAmountRaw: "1000000000000000000", maxRecipients: 1000,
  claimedCount: 0, qualifiedCount: 1, startBlock: "100", tradeRequiredFromBlock: "0",
};
const ELIGIBLE: LaunchCampaignWalletStatus = { wallet: A, state: "eligible", tradeRequired: false, slot: 0, coin: B, launchBlock: "101" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  state.address = A;
  state.freshPreview = false;
  state.marketRenders = 0;
  state.market = { readLaunchCampaign: vi.fn().mockResolvedValue(ACTIVE), readLaunchCampaignWallet: vi.fn().mockResolvedValue(ELIGIBLE) };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("optional launch campaign reads", () => {
  it("remains absent in a preview market without campaign methods", () => {
    state.market = {};
    const { result } = renderHook(() => useLaunchCampaign(true));
    expect(result.current.summary).toBeNull();
    expect(result.current.wallet).toBeNull();
    expect(result.current.error).toBe(false);
  });

  it("settles when a preview adapter is recreated on every render without campaign methods", () => {
    // Match CreateScreen's isolated preview harness; bound a regression before it can exhaust memory.
    state.freshPreview = true;
    const { result, rerender } = renderHook(() => useLaunchCampaign(true));
    rerender();
    expect(result.current.summary).toBeNull();
    expect(result.current.wallet).toBeNull();
    expect(result.current.error).toBe(false);
    expect(state.marketRenders).toBeLessThan(5);
  });

  it("never loads wallet eligibility while disabled", async () => {
    state.market!.readLaunchCampaign!.mockResolvedValue({ enabled: false });
    const { result } = renderHook(() => useLaunchCampaign(true));
    await waitFor(() => expect(result.current.summary).toEqual({ enabled: false }));
    expect(state.market!.readLaunchCampaignWallet).not.toHaveBeenCalled();
    expect(result.current.wallet).toBeNull();
  });

  it.each(["banner", "disconnected"] as const)("loads only public configuration for %s", async kind => {
    if (kind === "disconnected") state.address = null;
    const { result } = renderHook(() => useLaunchCampaign(kind === "disconnected"));
    await waitFor(() => expect(result.current.summary).toEqual(ACTIVE));
    expect(state.market!.readLaunchCampaignWallet).not.toHaveBeenCalled();
  });

  it("matches wallet addresses without case sensitivity", async () => {
    state.market!.readLaunchCampaignWallet!.mockResolvedValue({ ...ELIGIBLE, wallet: A.toUpperCase().replace("0X", "0x") });
    const { result } = renderHook(() => useLaunchCampaign(true));
    await waitFor(() => expect(result.current.wallet?.state).toBe("eligible"));
    expect(state.market!.readLaunchCampaignWallet).toHaveBeenCalledWith(A);
  });

  it("refuses an eligibility response belonging to another wallet", async () => {
    state.market!.readLaunchCampaignWallet!.mockResolvedValue({ ...ELIGIBLE, wallet: B });
    const { result } = renderHook(() => useLaunchCampaign(true));
    await waitFor(() => expect(result.current.summary).toEqual(ACTIVE));
    expect(result.current.wallet).toBeNull();
  });

  it("retains the public banner and blocks eligibility when only the wallet read fails", async () => {
    state.market!.readLaunchCampaignWallet!.mockRejectedValue(new Error("index unavailable"));
    const { result } = renderHook(() => useLaunchCampaign(true));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.summary).toEqual(ACTIVE);
    expect(result.current.wallet).toBeNull();
  });

  it("hides the feature when its configuration request fails", async () => {
    state.market!.readLaunchCampaign!.mockRejectedValue(new Error("configuration unavailable"));
    const { result } = renderHook(() => useLaunchCampaign(true));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.summary).toBeNull();
    expect(result.current.wallet).toBeNull();
    expect(state.market!.readLaunchCampaignWallet).not.toHaveBeenCalled();
  });

  it("clears a previous wallet's eligibility immediately and ignores its late response", async () => {
    const previous = deferred<LaunchCampaignWalletStatus>();
    const next = deferred<LaunchCampaignWalletStatus>();
    state.market!.readLaunchCampaignWallet!.mockImplementation((address: string) => address === A ? previous.promise : next.promise);
    const { result, rerender } = renderHook(() => useLaunchCampaign(true));
    await waitFor(() => expect(state.market!.readLaunchCampaignWallet).toHaveBeenCalledWith(A));
    state.address = B;
    rerender();
    expect(result.current.wallet).toBeNull();
    await waitFor(() => expect(state.market!.readLaunchCampaignWallet).toHaveBeenCalledWith(B));
    await act(async () => { previous.resolve(ELIGIBLE); });
    expect(result.current.wallet).toBeNull();
    await act(async () => { next.resolve({ wallet: B, state: "launch_required", tradeRequired: false }); });
    expect(result.current.wallet?.wallet).toBe(B);
    expect(result.current.wallet?.state).toBe("launch_required");
  });

  it("a manual refresh supersedes an in-flight response without retaining stale eligibility", async () => {
    const old = deferred<LaunchCampaignSummary>();
    state.market!.readLaunchCampaign!.mockReturnValueOnce(old.promise).mockResolvedValue({ enabled: false });
    const { result } = renderHook(() => useLaunchCampaign(true));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.summary).toEqual({ enabled: false }));
    await act(async () => { old.resolve(ACTIVE); });
    expect(result.current.summary).toEqual({ enabled: false });
    expect(result.current.wallet).toBeNull();
  });

  it("keeps one poll in flight and stops polling when unmounted", async () => {
    vi.useFakeTimers();
    const pending = deferred<LaunchCampaignSummary>();
    state.market!.readLaunchCampaign!.mockReturnValue(pending.promise);
    const reader = state.market!.readLaunchCampaign!;
    const { result, unmount } = renderHook(() => useLaunchCampaign(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(reader).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(ACTIVE); });
    expect(result.current.wallet).toEqual(ELIGIBLE);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(reader).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
