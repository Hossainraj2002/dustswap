import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { canSelectPlatformToken, parsePlatformTokenInfo, PLATFORM_TOKEN_LAUNCH_AT, PLATFORM_TOKEN_LAUNCHER } from "./config";

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const INFO = { enabled: true as const, launchAt: PLATFORM_TOKEN_LAUNCH_AT, launcher: PLATFORM_TOKEN_LAUNCHER, tokenAddress: null };

describe("official platform token configuration", () => {
  it("accepts explicit launch times and the designated launcher, with or without a pinned token", () => {
    expect(parsePlatformTokenInfo(INFO)).toEqual(INFO);
    const pinned = { ...INFO, launcher: getAddress(PLATFORM_TOKEN_LAUNCHER), tokenAddress: TOKEN, launchAt: "2026-10-11T15:00:00+06:00" };
    expect(parsePlatformTokenInfo(pinned)).toEqual(pinned);
    expect(Date.parse(pinned.launchAt)).toBe(Date.parse(PLATFORM_TOKEN_LAUNCH_AT));
  });

  it("treats a disabled response as disabled even if it carries extra fields", () => {
    expect(parsePlatformTokenInfo({ ...INFO, enabled: false, tokenAddress: TOKEN })).toEqual({ enabled: false });
  });

  it.each([
    ["null response", null],
    ["array response", []],
    ["missing fields", { enabled: true }],
    ["non-boolean activation", { ...INFO, enabled: "true" }],
    ["local launch time", { ...INFO, launchAt: "2026-10-11T09:00:00" }],
    ["invalid launch time", { ...INFO, launchAt: "not-a-dateZ" }],
    ["wrong launcher", { ...INFO, launcher: OTHER_WALLET }],
    ["malformed launcher", { ...INFO, launcher: "0x123" }],
    ["omitted token selection", { enabled: true, launchAt: INFO.launchAt, launcher: INFO.launcher }],
    ["malformed pinned token", { ...INFO, tokenAddress: "MEMEFUN" }],
    ["zero pinned token", { ...INFO, tokenAddress: zeroAddress }],
  ])("rejects %s rather than granting official selection", (_name, value) => {
    expect(() => parsePlatformTokenInfo(value)).toThrow("Invalid platform token response.");
  });

  it("allows only the designated wallet before any official token has been pinned", () => {
    expect(canSelectPlatformToken(INFO, getAddress(PLATFORM_TOKEN_LAUNCHER))).toBe(true);
    expect(canSelectPlatformToken(INFO, OTHER_WALLET)).toBe(false);
    expect(canSelectPlatformToken(INFO, null)).toBe(false);
    expect(canSelectPlatformToken(null, PLATFORM_TOKEN_LAUNCHER)).toBe(false);
    expect(canSelectPlatformToken({ enabled: false }, PLATFORM_TOKEN_LAUNCHER)).toBe(false);
    expect(canSelectPlatformToken({ ...INFO, tokenAddress: TOKEN }, PLATFORM_TOKEN_LAUNCHER)).toBe(false);
    expect(canSelectPlatformToken({ ...INFO, launcher: OTHER_WALLET }, PLATFORM_TOKEN_LAUNCHER)).toBe(false);
  });
});
