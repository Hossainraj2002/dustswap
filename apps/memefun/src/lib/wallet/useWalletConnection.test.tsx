/** @vitest-environment jsdom */
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionProvider, useWalletConnection } from "./useWalletConnection";

const sdk = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, status: "disconnected", connector: undefined as { id: string } | undefined },
  wallets: [] as { address: string; type: string; meta: { id: string; name: string }; disconnect: ReturnType<typeof vi.fn> }[],
  ready: true,
  walletsReady: false,
  config: { storage: { getItem: vi.fn().mockResolvedValue(null) } },
  success: null as null | ((result: { wallet: unknown }) => Promise<void>),
  activate: vi.fn<(...args: unknown[]) => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  connect: vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ready: sdk.ready, authenticated: false, logout: vi.fn() }),
  useActiveWallet: () => ({ wallet: sdk.wallets[0] }),
  useWallets: () => ({ wallets: [...sdk.wallets], ready: sdk.walletsReady }),
  useConnectWallet: (callbacks: { onSuccess: typeof sdk.success }) => {
    sdk.success = callbacks.onSuccess;
    return { connectWallet: sdk.connect };
  },
}));
vi.mock("./activateWallet", () => ({
  activatePrivyWallet: async (_config: unknown, wallet: { address: string; meta: { id: string } }) => {
    await sdk.activate(wallet);
    if (sdk.account.status === "connected") sdk.account.connector = { id: `memefun.${wallet.meta.id}.${wallet.address}.1` };
  },
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ ...sdk.account }),
  useConfig: () => sdk.config,
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
const makeWallet = (address = alice, id = "test-wallet") => ({ address, type: "ethereum", meta: { id, name: id }, disconnect: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  sdk.ready = true;
  sdk.walletsReady = false;
  sdk.config.storage.getItem.mockResolvedValue(null);
  sdk.account = { address: undefined, status: "disconnected", connector: undefined };
  sdk.wallets = [];
  sdk.activate = vi.fn().mockResolvedValue(undefined);
  sdk.disconnect = vi.fn().mockResolvedValue(undefined);
  sdk.connect = vi.fn();
  sdk.success = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("explicit wallet reconciliation", () => {
  it("waits for Privy to finish loading remembered wallets", async () => {
    sdk.wallets = [makeWallet()];
    sdk.account = { address: alice, status: "connecting", connector: undefined };
    const hook = renderHook(useWalletConnection, { wrapper });
    for (let i = 0; i < 10; i++) {
      sdk.account.status = i % 2 ? "reconnecting" : "disconnected";
      hook.rerender();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    }
    expect(sdk.activate).not.toHaveBeenCalled();
    expect(sdk.disconnect).not.toHaveBeenCalled();
  });

  it("restores a selected wallet once despite fresh SDK wallet arrays", async () => {
    const wallet = makeWallet();
    sdk.wallets = [wallet];
    sdk.walletsReady = true;
    sdk.activate.mockImplementation(async () => { sdk.account = { address: alice, status: "connected", connector: undefined }; });
    const hook = renderHook(useWalletConnection, { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    for (let i = 0; i < 20; i++) hook.rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(sdk.activate).toHaveBeenCalledExactlyOnceWith(wallet);
    expect(hook.result.current.isConnecting).toBe(false);
  });

  it("restores once when React replays mount effects in Strict Mode", async () => {
    sdk.wallets = [makeWallet()];
    sdk.walletsReady = true;
    sdk.activate.mockImplementation(async () => { sdk.account = { address: alice, status: "connected", connector: undefined }; });
    const strictWrapper = ({ children }: { children: ReactNode }) => <StrictMode><WalletConnectionProvider enabled>{children}</WalletConnectionProvider></StrictMode>;
    const hook = renderHook(useWalletConnection, { wrapper: strictWrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    hook.rerender();
    expect(sdk.activate).toHaveBeenCalledTimes(1);
  });

  it("does not silently pick among multiple remembered wallets", async () => {
    sdk.wallets = [makeWallet(), makeWallet(bob, "other-wallet")];
    sdk.walletsReady = true;
    renderHook(useWalletConnection, { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(sdk.activate).not.toHaveBeenCalled();
  });

  it("restores the saved provider when two wallets expose the same address", async () => {
    const selected = makeWallet(alice, "second-provider");
    sdk.wallets = [makeWallet(), selected];
    sdk.walletsReady = true;
    window.localStorage.setItem("memefun:selected-wallet-v1", JSON.stringify({ address: alice, id: selected.meta.id }));
    sdk.activate.mockImplementation(async () => { sdk.account = { address: alice, status: "connected", connector: undefined }; });
    renderHook(useWalletConnection, { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(sdk.activate).toHaveBeenCalledExactlyOnceWith(selected);
  });

  it("activates the explicitly selected provider rather than another with the same address", async () => {
    const selected = makeWallet(alice, "second-provider");
    sdk.wallets = [makeWallet(), selected];
    renderHook(useWalletConnection, { wrapper });
    await act(async () => { await sdk.success!({ wallet: selected }); });
    expect(sdk.activate).toHaveBeenCalledExactlyOnceWith(selected);
  });

  it("rebinds a new SDK provider for the same address even while another provider is connected", async () => {
    const selected = makeWallet(alice, "second-provider");
    sdk.wallets = [makeWallet(), selected];
    sdk.account = { address: alice, status: "connected", connector: { id: `memefun.test-wallet.${alice}.1` } };
    sdk.activate.mockResolvedValue(undefined);
    renderHook(useWalletConnection, { wrapper });
    await act(async () => { await sdk.success!({ wallet: selected }); });
    expect(sdk.activate).toHaveBeenCalledExactlyOnceWith(selected);
  });

  it("honors the manual disconnect marker on a new mount", async () => {
    sdk.wallets = [makeWallet()];
    sdk.walletsReady = true;
    window.localStorage.setItem("memefun:wallet-manual-disconnect", "1");
    const hook = renderHook(useWalletConnection, { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(sdk.activate).not.toHaveBeenCalled();
    expect(hook.result.current.isConnecting).toBe(false);
  });

  it("ends Connecting when the last failed native attempt was interrupted by pending state", async () => {
    const wallet = makeWallet();
    sdk.wallets = [wallet];
    const failures: ((error: Error) => void)[] = [];
    sdk.activate.mockImplementation(() => new Promise<void>((_, reject) => { failures.push(reject); }));
    const hook = renderHook(useWalletConnection, { wrapper });
    await act(async () => { await sdk.success!({ wallet }); });
    for (let attempt = 0; attempt < 6; attempt++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(sdk.activate).toHaveBeenCalledTimes(attempt + 1);
      sdk.account.status = "connecting";
      hook.rerender();
      await act(async () => {
        sdk.account.status = "disconnected";
        failures[attempt]!(new Error("Provider unavailable"));
        hook.rerender();
      });
    }
    expect(hook.result.current.isConnecting).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(sdk.activate).toHaveBeenCalledTimes(6);
  });

  it("keeps one bounded retry schedule despite SDK callback and wallet-list churn", async () => {
    const wallet = makeWallet();
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
    const wallet = makeWallet();
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
    const wallet = makeWallet();
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
    const wallet = makeWallet();
    sdk.wallets = [wallet, makeWallet(bob, "other-wallet")];
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
