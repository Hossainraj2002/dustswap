/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_TOKEN_LAUNCH_AT, PLATFORM_TOKEN_LAUNCHER } from "./config";
import { usePlatformToken } from "./usePlatformToken";

const state = vi.hoisted(() => ({ preview: false, ready: true, chainId: 8453, apiUrl: "https://api.example.test", get: vi.fn() }));
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ preview: state.preview, ready: state.ready }) }));
vi.mock("@/lib/chain", () => ({ get TARGET_CHAIN_ID() { return state.chainId; } }));
vi.mock("@/lib/live/config", () => ({ get API_URL() { return state.apiUrl; } }));
vi.mock("@/lib/live/api", () => ({ createApi: () => ({ get: state.get }) }));

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const INFO = { enabled: true as const, launchAt: PLATFORM_TOKEN_LAUNCH_AT, launcher: PLATFORM_TOKEN_LAUNCHER, tokenAddress: null };
beforeEach(() => {
  vi.useFakeTimers();
  state.preview = false; state.ready = true; state.chainId = 8453; state.apiUrl = "https://api.example.test";
  state.get.mockReset().mockResolvedValue(INFO);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const settle = () => act(async () => { await Promise.resolve(); });

describe("official platform token reads", () => {
  it("makes verified configuration available and polls for the newly pinned token", async () => {
    state.get.mockResolvedValueOnce(INFO).mockResolvedValueOnce({ ...INFO, tokenAddress: TOKEN });
    const { result } = renderHook(() => usePlatformToken());
    await settle();
    expect(result.current).toEqual({ info: INFO, available: true, showAnnouncement: true });
    expect(state.get.mock.calls[0]?.[0]).toBe("/v1/platform-token");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.info).toEqual({ ...INFO, tokenAddress: TOKEN });
    expect(state.get).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the response belongs to another launcher", async () => {
    state.get.mockResolvedValue({ ...INFO, launcher: TOKEN });
    const { result } = renderHook(() => usePlatformToken());
    await settle();
    expect(result.current.info).toBeNull();
    expect(result.current.available).toBe(false);
  });

  it("preserves a known official address through an outage while disabling new selection", async () => {
    const pinned = { ...INFO, tokenAddress: TOKEN };
    state.get.mockResolvedValueOnce(pinned).mockRejectedValueOnce(new Error("API unavailable")).mockResolvedValueOnce(pinned);
    const { result } = renderHook(() => usePlatformToken());
    await settle();
    expect(result.current.info).toEqual(pinned);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.info).toEqual(pinned);
    expect(result.current.available).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.available).toBe(true);
  });

  it.each([
    { name: "preview", preview: true, showAnnouncement: false },
    { name: "an unsettled preview scenario", ready: false, showAnnouncement: false },
    { name: "another chain", chainId: 84532, showAnnouncement: false },
    { name: "a build without an API", apiUrl: "", showAnnouncement: true },
  ])("does not fetch during $name", async ({ name: _name, showAnnouncement, ...override }) => {
    Object.assign(state, override);
    const { result } = renderHook(() => usePlatformToken());
    await settle();
    expect(state.get).not.toHaveBeenCalled();
    expect(result.current).toEqual({ info: null, available: false, showAnnouncement });
  });

  it("waits until the preview scenario is settled before requesting live settings", async () => {
    state.ready = false;
    const { result, rerender } = renderHook(() => usePlatformToken());
    expect(state.get).not.toHaveBeenCalled();
    state.ready = true;
    rerender();
    await settle();
    expect(result.current.available).toBe(true);
    expect(state.get).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight read on unmount and never schedules a late poll", async () => {
    let resolve!: (value: unknown) => void;
    state.get.mockReturnValue(new Promise(value => { resolve = value; }));
    const { unmount } = renderHook(() => usePlatformToken());
    const signal = state.get.mock.calls[0]?.[1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(INFO); });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(state.get).toHaveBeenCalledTimes(1);
  });

  it("removes its scheduled poll when unmounted", async () => {
    const { unmount } = renderHook(() => usePlatformToken());
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
