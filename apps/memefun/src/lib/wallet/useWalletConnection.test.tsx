/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionProvider, useWalletConnection } from "./useWalletConnection";

const sdk = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, status: "disconnected" },
  wallets: [] as { address: string; type: string; disconnect: ReturnType<typeof vi.fn> }[],
  ready: true,
  success: null as null | ((result: { wallet: unknown }) => Promise<void>),
  activate: vi.fn<(...args: unknown[]) => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  connect: vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ready: sdk.ready, authenticated: false, logout: vi.fn() }),
  useActiveWallet: () => ({ wallet: sdk.wallets[0] }),
  useWallets: () => ({ wallets: [...sdk.wallets] }),
  useConnectWallet: (callbacks: { onSuccess: typeof sdk.success }) => {
    sdk.success = callbacks.onSuccess;
    return { connectWallet: sdk.connect };
  },
}));
vi.mock("@privy-io/wagmi", () => ({
  // The actual SDK callback changes with its connections map and connect mutation.
  useSetActiveWallet: () => ({ setActiveWallet: (...args: unknown[]) => sdk.activate(...args) }),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ ...sdk.account }),
  useDisconnect: () => ({ disconnectAsync: () => sdk.disconnect() }),
}));
vi.mock("./ethereumProviders", () => ({
  ensureOkxEip6963Shim: () => false,
  hasAnyInjectedEthereumProvider: () => false,
  hasInjectedOkxWallet: () => false,
  hasInjectedTokenPocketWallet: () => false,
  isOkxAppBrowser: () => false,
  isTokenPocketAppBrowser: () => false,
  waitForInjectedProvider: vi.fn().mockResolvedValue(false),
}));

const wrapper = ({ children }: { children: ReactNode }) => <WalletConnectionProvider enabled>{children}</WalletConnectionProvider>;
const alice = "0x0000000000000000000000000000000000000001";
const bob = "0x0000000000000000000000000000000000000002";

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  sdk.ready = true;
  sdk.account = { address: undefined, status: "disconnected" };
  sdk.wallets = [];
  sdk.activate = vi.fn().mockResolvedValue(undefined);
  sdk.disconnect = vi.fn().mockResolvedValue(undefined);
  sdk.connect = vi.fn();
  sdk.success = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("explicit wallet reconciliation", () => {
  it("does not activate remembered wallets during automatic SDK reconnect on page load", async () => {
    sdk.wallets = [{ address: alice, type: "ethereum", disconnect: vi.fn() }];
    sdk.account = { address: alice, status: "connecting" };
    const hook = renderHook(useWalletConnection, { wrapper });
    for (let i = 0; i < 10; i++) {
      sdk.account.status = i % 2 ? "reconnecting" : "disconnected";
      hook.rerender();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    }
    expect(sdk.activate).not.toHaveBeenCalled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
  });

  it("keeps one bounded retry schedule despite SDK callback and wallet-list churn", async () => {
    const wallet = { address: alice, type: "ethereum", disconnect: vi.fn() };
    sdk.wallets = [wallet];
    const hook = renderHook(useWalletConnection, { wrapper });
    await act(async () => { await sdk.success!({ wallet }); });
    expect(sdk.activate).toHaveBeenCalledTimes(1);
    await act(async () => { await sdk.success!({ wallet }); });
    for (let i = 0; i < 12; i++) hook.rerender();
    expect(sdk.activate).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(sdk.activate).toHaveBeenCalledTimes(6);
    for (let i = 0; i < 4; i++) hook.rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(sdk.activate).toHaveBeenCalledTimes(6);
  });

  it("does not reset the retry budget when wagmi alternates pending and disconnected", async () => {
    const wallet = { address: alice, type: "ethereum", disconnect: vi.fn() };
    sdk.wallets = [wallet];
    const hook = renderHook(useWalletConnection, { wrapper });
    await act(async () => { await sdk.success!({ wallet }); });
    for (let i = 0; i < 8; i++) {
      sdk.account.status = "connecting";
      hook.rerender();
      sdk.account.status = "disconnected";
      hook.rerender();
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    }
    expect(sdk.activate).toHaveBeenCalledTimes(6);
  });

  it("starts a fresh bounded attempt for an explicitly retried choice of the same wallet", async () => {
    const wallet = { address: alice, type: "ethereum", disconnect: vi.fn() };
    sdk.wallets = [wallet];
    const hook = renderHook(useWalletConnection, { wrapper });
    await act(async () => { await sdk.success!({ wallet }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(sdk.activate).toHaveBeenCalledTimes(6);
    // Both updates may be batched: address and needsReconcile can end unchanged.
    await act(async () => { await hook.result.current.openWalletModal(); await sdk.success!({ wallet }); });
    expect(sdk.activate).toHaveBeenCalledTimes(7);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(sdk.activate).toHaveBeenCalledTimes(12);
  });

  it("coalesces repeated Connect taps and cancels a pending picker after disconnect", async () => {
    sdk.ready = false;
    const hook = renderHook(useWalletConnection, { wrapper });
    const first = hook.result.current.openWalletModal();
    expect(hook.result.current.openWalletModal()).toBe(first);
    await act(async () => { await hook.result.current.disconnectWallet(); });
    sdk.ready = true;
    hook.rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await first; });
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("never switches to another remembered wallet and manual disconnect cancels retries", async () => {
    const wallet = { address: alice, type: "ethereum", disconnect: vi.fn() };
    sdk.wallets = [wallet, { address: bob, type: "ethereum", disconnect: vi.fn() }];
    const hook = renderHook(useWalletConnection, { wrapper });
    await act(async () => { await sdk.success!({ wallet }); });
    await act(async () => { await hook.result.current.disconnectWallet(); });
    sdk.wallets = [sdk.wallets[1]!];
    hook.rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(sdk.activate).toHaveBeenCalledTimes(1);
    expect(sdk.activate.mock.calls.every(([selected]) => (selected as { address: string }).address === alice)).toBe(true);
    await act(async () => { await sdk.success!({ wallet }); });
    expect(sdk.activate).toHaveBeenCalledTimes(1);
  });

  it("does not open a wallet picker before Privy is ready", async () => {
    sdk.ready = false;
    const hook = renderHook(useWalletConnection, { wrapper });
    const error = hook.result.current.openWalletModal().catch((failure: unknown) => failure);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(await error).toBeInstanceOf(Error);
    expect(sdk.connect).not.toHaveBeenCalled();
  });
});
