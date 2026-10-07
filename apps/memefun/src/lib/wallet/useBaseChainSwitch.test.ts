/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TARGET_CHAIN_ID } from "@/lib/chain";
import { useBaseChainSwitch } from "./useBaseChainSwitch";

const sdk = vi.hoisted(() => ({
  chainId: 1,
  isConnected: true,
  address: "0x00000000000000000000000000000000000000aa",
  provider: null as null | { request: ReturnType<typeof vi.fn> },
  switchChain: vi.fn<(...args: unknown[]) => Promise<{ id: number }>>(),
}));
vi.mock("wagmi", () => {
  const connector = { uid: "selected", getProvider: async () => sdk.provider };
  return {
    useAccount: () => ({ chainId: sdk.chainId, address: sdk.address, isConnected: sdk.isConnected, connector }),
    useWalletClient: () => ({ data: null }),
    useSwitchChain: () => ({ isPending: false, switchChainAsync: sdk.switchChain }),
  };
});
vi.mock("./rpc", () => ({ getRpcUrlForChain: () => "https://mainnet.base.org" }));
vi.mock("./paymaster", () => ({ isUserRejectedRequest: (error: { code?: number }) => error?.code === 4001 }));

beforeEach(() => {
  vi.useFakeTimers();
  sdk.chainId = 1;
  sdk.isConnected = true;
  sdk.address = "0x00000000000000000000000000000000000000aa";
  sdk.provider = { request: vi.fn().mockImplementation(async ({ method }: { method: string }) => method === "eth_chainId" ? "0x1" : null) };
  sdk.switchChain = vi.fn().mockResolvedValue({ id: TARGET_CHAIN_ID });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("confirmed wallet network switching", () => {
  it("rejects a successful SDK response when the signing provider never changes chain", async () => {
    const hook = renderHook(useBaseChainSwitch);
    await act(async () => { await Promise.resolve(); });
    let result: unknown;
    await act(async () => {
      const pending = hook.result.current.switchToBase().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(13_000);
      result = await pending;
    });
    expect(result).toBeInstanceOf(Error);
    expect(hook.result.current.isOnBase).toBe(false);
    expect(hook.result.current.isSwitching).toBe(false);
  });

  it("rejects the provider fallback when its switch method silently succeeds without switching", async () => {
    sdk.switchChain.mockRejectedValue(new Error("SDK connector cannot switch"));
    const hook = renderHook(useBaseChainSwitch);
    let result: unknown;
    await act(async () => {
      const pending = hook.result.current.switchToBase().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(6_200);
      result = await pending;
    });
    expect(result).toBeInstanceOf(Error);
    expect(hook.result.current.isOnBase).toBe(false);
  });

  it("reports success only after the provider confirms the target network", async () => {
    let chain = 1;
    sdk.provider!.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return `0x${chain.toString(16)}`;
      return null;
    });
    sdk.switchChain.mockImplementation(async () => { chain = TARGET_CHAIN_ID; return { id: TARGET_CHAIN_ID }; });
    const hook = renderHook(useBaseChainSwitch);
    await act(async () => { expect(await hook.result.current.switchToBase()).toBe(true); });
    expect(hook.result.current.isOnBase).toBe(true);
    expect(hook.result.current.isSwitching).toBe(false);
  });

  it("does not mistake a malformed target-chain prefix for confirmation", async () => {
    sdk.provider!.request.mockImplementation(async ({ method }: { method: string }) => method === "eth_chainId" ? `0x${TARGET_CHAIN_ID.toString(16)}invalid` : null);
    const hook = renderHook(useBaseChainSwitch);
    await act(async () => {
      const pending = hook.result.current.switchToBase();
      const error = pending.catch((failure: unknown) => failure);
      await vi.advanceTimersByTimeAsync(13_000);
      expect(await error).toBeInstanceOf(Error);
    });
    expect(hook.result.current.isOnBase).toBe(false);
  });

  it("keeps a rejected wallet switch rejected without issuing a fallback request", async () => {
    sdk.switchChain.mockRejectedValue(Object.assign(new Error("User rejected"), { code: 4001 }));
    const hook = renderHook(useBaseChainSwitch);
    await act(async () => { await expect(hook.result.current.switchToBase()).rejects.toThrow("Please switch"); });
    expect(sdk.provider!.request.mock.calls.every(([request]) => (request as { method: string }).method === "eth_chainId")).toBe(true);
    expect(hook.result.current.isOnBase).toBe(false);
  });

  it("never falls back to a different injected wallet when the connector provider is missing", async () => {
    sdk.provider = null;
    const unrelated = { request: vi.fn().mockResolvedValue(`0x${TARGET_CHAIN_ID.toString(16)}`) };
    Object.defineProperty(window, "ethereum", { value: unrelated, configurable: true });
    sdk.switchChain.mockRejectedValue(new Error("No provider for selected wallet"));
    const hook = renderHook(useBaseChainSwitch);
    await act(async () => { await expect(hook.result.current.switchToBase()).rejects.toThrow(); });
    expect(unrelated.request).not.toHaveBeenCalled();
    expect(hook.result.current.isOnBase).toBe(false);
    Reflect.deleteProperty(window, "ethereum");
  });

  it("releases a switch when the selected provider's initial chain read stalls", async () => {
    sdk.provider!.request.mockImplementation(() => new Promise(() => undefined));
    const hook = renderHook(useBaseChainSwitch);
    let failure: unknown;
    await act(async () => {
      void hook.result.current.switchToBase().catch(error => { failure = error; });
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(failure).toBeInstanceOf(Error);
    expect(hook.result.current.isSwitching).toBe(false);
    expect(hook.result.current.isOnBase).toBe(false);
    expect(sdk.switchChain).not.toHaveBeenCalled();
  });

  it("times out a stalled confirmation and ignores its late target-chain response", async () => {
    let stalled = false;
    const lateReads: Array<(chainId: string) => void> = [];
    sdk.provider!.request.mockImplementation(({ method }: { method: string }) => {
      if (method === "eth_chainId" && stalled) return new Promise<string>(resolve => lateReads.push(resolve));
      return Promise.resolve(method === "eth_chainId" ? "0x1" : null);
    });
    sdk.switchChain.mockImplementation(async () => { stalled = true; return { id: TARGET_CHAIN_ID }; });
    const hook = renderHook(useBaseChainSwitch);
    await act(async () => { await Promise.resolve(); });
    let failure: unknown;
    await act(async () => {
      void hook.result.current.switchToBase().catch(error => { failure = error; });
      await vi.advanceTimersByTimeAsync(6200);
    });
    expect(failure).toBeInstanceOf(Error);
    expect(hook.result.current.isSwitching).toBe(false);
    expect(sdk.provider!.request.mock.calls.every(([request]) => (request as { method: string }).method === "eth_chainId")).toBe(true);
    await act(async () => lateReads.forEach(resolve => resolve(`0x${TARGET_CHAIN_ID.toString(16)}`)));
    expect(hook.result.current.isOnBase).toBe(false);
  });

  it("cancels an old wallet's stalled read when the selected address changes", async () => {
    const lateReads: Array<(chainId: string) => void> = [];
    sdk.provider!.request.mockImplementation(() => new Promise<string>(resolve => lateReads.push(resolve)));
    const hook = renderHook(useBaseChainSwitch);
    let failure: unknown;
    await act(async () => {
      void hook.result.current.switchToBase().catch(error => { failure = error; });
      await Promise.resolve();
    });
    expect(hook.result.current.isSwitching).toBe(true);
    sdk.address = "0x00000000000000000000000000000000000000bb";
    sdk.provider = { request: vi.fn().mockResolvedValue("0x1") };
    await act(async () => hook.rerender());
    expect(failure).toBeInstanceOf(Error);
    expect(hook.result.current.isSwitching).toBe(false);
    await act(async () => lateReads.forEach(resolve => resolve(`0x${TARGET_CHAIN_ID.toString(16)}`)));
    expect(hook.result.current.isOnBase).toBe(false);
    expect(sdk.switchChain).not.toHaveBeenCalled();
  });

  it("detaches a pending SDK switch on unmount without processing its late completion", async () => {
    let complete!: (chain: { id: number }) => void;
    sdk.switchChain.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const hook = renderHook(useBaseChainSwitch);
    let failure: unknown;
    await act(async () => {
      void hook.result.current.switchToBase().catch(error => { failure = error; });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sdk.switchChain).toHaveBeenCalledTimes(1);
    hook.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(failure).toBeInstanceOf(Error);
    const priorReads = sdk.provider!.request.mock.calls.length;
    await act(async () => complete({ id: TARGET_CHAIN_ID }));
    expect(sdk.provider!.request.mock.calls).toHaveLength(priorReads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates simultaneous switches from separate controls", async () => {
    sdk.switchChain.mockImplementation(() => new Promise(() => undefined));
    const hook = renderHook(useBaseChainSwitch);
    let duplicate: unknown;
    await act(async () => {
      void hook.result.current.switchToBase().catch(() => undefined);
      duplicate = await hook.result.current.switchToBase().catch(error => error);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(duplicate).toBeInstanceOf(Error);
    expect(sdk.switchChain).toHaveBeenCalledTimes(1);
    expect(hook.result.current.isSwitching).toBe(true);
  });
});
