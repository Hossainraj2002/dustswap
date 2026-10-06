/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TARGET_CHAIN_ID } from "@/lib/chain";
import { useBaseChainSwitch } from "./useBaseChainSwitch";

const sdk = vi.hoisted(() => ({
  chainId: 1,
  isConnected: true,
  provider: null as null | { request: ReturnType<typeof vi.fn> },
  switchChain: vi.fn<(...args: unknown[]) => Promise<{ id: number }>>(),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ chainId: sdk.chainId, isConnected: sdk.isConnected, connector: { getProvider: async () => sdk.provider } }),
  useWalletClient: () => ({ data: null }),
  useSwitchChain: () => ({ isPending: false, switchChainAsync: sdk.switchChain }),
}));
vi.mock("./rpc", () => ({ getRpcUrlForChain: () => "https://mainnet.base.org" }));
vi.mock("./paymaster", () => ({ isUserRejectedRequest: (error: { code?: number }) => error?.code === 4001 }));

beforeEach(() => {
  vi.useFakeTimers();
  sdk.chainId = 1;
  sdk.isConnected = true;
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
});
