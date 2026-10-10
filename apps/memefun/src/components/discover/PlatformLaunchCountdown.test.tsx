/** @vitest-environment jsdom */
import { renderToString } from "react-dom/server";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_TOKEN_LAUNCH_AT } from "@/lib/platform-token/config";
import { PlatformLaunchCountdown } from "./PlatformLaunchCountdown";

const LAUNCH_AT = PLATFORM_TOKEN_LAUNCH_AT;
const LAUNCH_TIME = Date.parse(LAUNCH_AT);
const value = (unit: string) => screen.getByText(unit).parentElement?.querySelector("dd")?.textContent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("platform launch countdown", () => {
  it("renders stable server placeholders and an explicit UTC launch date", () => {
    vi.setSystemTime(LAUNCH_TIME - 10_000);
    const first = renderToString(<PlatformLaunchCountdown launchAt={LAUNCH_AT} />);
    vi.setSystemTime(LAUNCH_TIME + 10_000);
    const second = renderToString(<PlatformLaunchCountdown launchAt={LAUNCH_AT} />);
    expect(first).toBe(second);
    expect(first.match(/>--<\/dd>/g)).toHaveLength(4);
    expect(new DOMParser().parseFromString(first, "text/html").querySelector("time")?.textContent).toBe("10 October 2026 · 09:00 UTC");
    expect(first).toContain('src="/memefun-logo.png"');
  });

  it("displays days, hours, minutes and seconds without announcing every tick", () => {
    vi.setSystemTime(LAUNCH_TIME - (86_400 + 7_200 + 180 + 4) * 1_000);
    render(<PlatformLaunchCountdown launchAt={LAUNCH_AT} />);
    expect([value("Days"), value("Hours"), value("Minutes"), value("Seconds")]).toEqual(["01", "02", "03", "04"]);
    expect(screen.getByRole("timer").getAttribute("aria-live")).toBe("off");
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(value("Seconds")).toBe("03");
    expect(screen.getByRole("status").textContent).toBe("Countdown to launch");
  });

  it("does not interpret an unzoned launch time in the visitor's local timezone", () => {
    expect(renderToString(<PlatformLaunchCountdown launchAt="2026-10-10T09:00:00" />)).toBe("");
  });

  it("counts down to today's 09:00 UTC launch without an extra day", () => {
    vi.setSystemTime("2026-10-10T00:00:00Z");
    render(<PlatformLaunchCountdown launchAt={LAUNCH_AT} />);
    expect([value("Days"), value("Hours"), value("Minutes"), value("Seconds")]).toEqual(["00", "09", "00", "00"]);
    expect(screen.getByText("10 October 2026 · 09:00 UTC").getAttribute("datetime")).toBe("2026-10-10T09:00:00.000Z");
  });

  it("keeps the last partial second positive and opens the window without claiming a token is live", () => {
    vi.setSystemTime(LAUNCH_TIME - 500);
    render(<PlatformLaunchCountdown launchAt={LAUNCH_AT} />);
    expect(value("Seconds")).toBe("01");
    expect(screen.getByRole("status").textContent).toBe("Countdown to launch");
    act(() => { vi.advanceTimersByTime(1_000); });
    expect([value("Days"), value("Hours"), value("Minutes"), value("Seconds")]).toEqual(["00", "00", "00", "00"]);
    expect(screen.getByRole("status").textContent).toBe("Launch window is open");
    expect(screen.getByText("Official token details will appear here after creation.")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(value("Seconds")).toBe("00");
  });

  it("releases its shared clock interval when unmounted", () => {
    vi.setSystemTime(LAUNCH_TIME - 60_000);
    expect(vi.getTimerCount()).toBe(0);
    const view = render(<PlatformLaunchCountdown launchAt={LAUNCH_AT} />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
