/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletButton } from "@/components/shell/WalletButton";

const sdk = vi.hoisted(() => ({
  status: "disconnected",
  address: null as string | null,
  onBase: true,
  connect: vi.fn<() => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  error: vi.fn(),
}));
vi.mock("./WalletProvider", () => ({
  useWallet: () => ({ status: sdk.status, address: sdk.address, onBase: sdk.onBase, isSwitching: false, connect: sdk.connect, disconnect: sdk.disconnect }),
}));
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => sdk.error(...args) } }));
vi.mock("@/lib/market/MarketProvider", () => ({ useMarket: () => ({ market: null }) }));
vi.mock("@/components/shell/ThemeSegmented", () => ({ ThemeSegmented: () => null }));

beforeEach(() => {
  vi.useFakeTimers();
  sdk.status = "disconnected";
  sdk.address = null;
  sdk.onBase = true;
  sdk.connect = vi.fn().mockResolvedValue(undefined);
  sdk.disconnect = vi.fn().mockResolvedValue(undefined);
  sdk.error = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("connection recovery", () => {
  it("keeps the same explicit width across connection, account and network states", () => {
    const hook = render(<WalletButton />);
    const width = screen.getByRole("button", { name: "Connect" }).className.match(/w-\[\d+px\]/)?.[0];
    expect(width).toBeTruthy();
    sdk.status = "connecting";
    hook.rerender(<WalletButton />);
    expect(screen.getByRole("button", { name: "Connecting" }).className).toContain(width);
    sdk.status = "connected";
    sdk.address = "0x0000000000000000000000000000000000000001";
    hook.rerender(<WalletButton />);
    expect(screen.getByRole("button", { name: /^Account / }).className).toContain(width);
    sdk.onBase = false;
    hook.rerender(<WalletButton />);
    expect(screen.getByRole("button", { name: /^Switch to / }).className).toContain(width);
  });

  it("offers an explicit retry when the SDK stays pending, without opening a wallet automatically", async () => {
    sdk.status = "connecting";
    render(<WalletButton />);
    expect(screen.getByRole("button", { name: "Connecting" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    const retry = screen.getByRole("button", { name: "Retry connection" });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(sdk.disconnect).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(retry); });
    expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(sdk.connect).toHaveBeenCalledOnce();
    expect(sdk.disconnect.mock.invocationCallOrder[0]).toBeLessThan(sdk.connect.mock.invocationCallOrder[0]!);
    // Even a SDK disconnect that never updates its status cannot disable retry forever.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("button", { name: "Retry connection" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows a connection error instead of leaving a rejected promise unhandled", async () => {
    sdk.connect.mockRejectedValue(new Error("Wallet initialization did not finish"));
    render(<WalletButton />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    expect(sdk.error).toHaveBeenCalledWith("Wallet initialization did not finish");
  });
});
