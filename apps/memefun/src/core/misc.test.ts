import { describe, expect, it } from "vitest";
import { launchFeeBps, protectionRemainingSec } from "./antiSnipe";
import {
  formatAge,
  formatBps,
  formatCompact,
  formatCountdown,
  formatPercent,
  formatQuoteAmount,
  formatSmallNumber,
  formatUsd,
  fromUnits,
  shortAddress,
  toUnits,
} from "./format";
import { crossedMilestone, milestoneLabel, milestoneProgress } from "./milestones";
import { DEFAULT_SETTINGS, diffSettings, validateSettings } from "./settings";
import {
  normalizeTicker,
  validateDescription,
  validateName,
  validateTelegram,
  validateTicker,
  validateWebsite,
  validateXHandle,
} from "./validation";

describe("launch protection", () => {
  const protection = { startBps: 5000, durationSec: 15 };

  it("starts at the protection fee and ends at the normal fee", () => {
    expect(launchFeeBps(100, protection, 0)).toBe(5000);
    expect(launchFeeBps(100, protection, 7)).toBe(100 + Math.floor((4900 * 8) / 15));
    expect(launchFeeBps(100, protection, 15)).toBe(100);
    expect(launchFeeBps(100, protection, 999)).toBe(100);
    expect(launchFeeBps(100, protection, -5)).toBe(5000);
  });

  it("never increases over time", () => {
    let last = Infinity;
    for (let t = 0; t <= 20; t += 1) {
      const fee = launchFeeBps(250, protection, t);
      expect(fee).toBeLessThanOrEqual(last);
      last = fee;
    }
  });

  it("does nothing when the start is not above the normal fee", () => {
    expect(launchFeeBps(500, { startBps: 400, durationSec: 15 }, 0)).toBe(500);
    expect(launchFeeBps(500, { startBps: 5000, durationSec: 0 }, 0)).toBe(500);
  });

  it("reports remaining seconds for the countdown ring", () => {
    expect(protectionRemainingSec(0, 5000, protection)).toBe(10);
    expect(protectionRemainingSec(0, 60_000, protection)).toBe(0);
  });
});

describe("format", () => {
  it("writes tiny prices with subscript zeros", () => {
    expect(formatSmallNumber(0.0000041234)).toBe("0.0₅4123");
    expect(formatSmallNumber(0.00041)).toBe("0.0₃41");
    expect(formatSmallNumber(0.0123)).toBe("0.0123");
    expect(formatSmallNumber(12.5)).toBe("12.5");
    expect(formatSmallNumber(0)).toBe("0");
  });

  it("compacts large numbers", () => {
    expect(formatCompact(1234)).toBe("1.23K");
    expect(formatCompact(15_000)).toBe("15K");
    expect(formatCompact(150_000)).toBe("150K");
    expect(formatCompact(5_600_000)).toBe("5.6M");
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(12.5)).toBe("12.5");
  });

  it("formats USD", () => {
    expect(formatUsd(84_200, { compact: true })).toBe("$84.2K");
    expect(formatUsd(5)).toBe("$5.00");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0)).toBe("$0");
  });

  it("formats percents and basis points", () => {
    expect(formatPercent(0.1234, { signed: true })).toBe("+12.3%");
    expect(formatPercent(-0.05)).toBe("-5%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatBps(125)).toBe("1.25%");
    expect(formatBps(100)).toBe("1%");
    expect(formatBps(5000)).toBe("50%");
  });

  it("formats quote amounts, ages, countdowns and addresses", () => {
    expect(formatQuoteAmount(0.042, "ETH")).toBe("0.042 ETH");
    expect(formatQuoteAmount(12.5, "USDC")).toBe("12.5 USDC");
    expect(formatAge(12_000)).toBe("12s");
    expect(formatAge(4 * 60_000)).toBe("4m");
    expect(formatAge(26 * 3_600_000)).toBe("1d");
    expect(formatCountdown(42_000)).toBe("0:42");
    expect(formatCountdown(3_909_000)).toBe("1:05:09");
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234...5678");
  });

  it("never emits the unicode ellipsis, em-dash or arrows", () => {
    const outputs = [shortAddress("0x1234567890abcdef1234567890abcdef12345678"), formatSmallNumber(0.000000123), formatCountdown(1)];
    for (const output of outputs) expect(output).not.toMatch(/[…—→]/);
  });

  it("converts units without float drift", () => {
    expect(toUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(toUnits("0.000001", 6)).toBe(1n);
    expect(toUnits("1.23456789", 6)).toBe(1_234_567n);
    expect(toUnits("abc", 18)).toBe(0n);
    expect(toUnits("", 18)).toBe(0n);
    expect(fromUnits(1_500_000_000_000_000_000n, 18)).toBe(1.5);
  });
});

describe("milestones", () => {
  it("tracks progress inside the current band", () => {
    expect(milestoneProgress(5_000, 5_000)).toMatchObject({ floor: 5_000, next: 10_000, progress: 0, reached: 0 });
    expect(milestoneProgress(7_500, 5_000).progress).toBeCloseTo(0.5, 9);
    expect(milestoneProgress(10_000, 5_000)).toMatchObject({ floor: 10_000, next: 25_000, progress: 0, reached: 1 });
    expect(milestoneProgress(2e9, 5_000)).toMatchObject({ next: null, progress: 1 });
  });

  it("detects crossings and labels them", () => {
    expect(crossedMilestone(60_000, 70_000)).toBe(69_000);
    expect(crossedMilestone(70_000, 80_000)).toBeNull();
    expect(milestoneLabel(69_000)).toBe("$69K");
    expect(milestoneLabel(2_500_000)).toBe("$2.5M");
  });
});

describe("validation", () => {
  it("validates names", () => {
    expect(validateName("  Frog   Coin ").value).toBe("Frog Coin");
    expect(validateName("").ok).toBe(false);
    expect(validateName("x".repeat(33)).ok).toBe(false);
    expect(validateName("bad‮Name").ok).toBe(false);
  });

  it("normalizes and validates tickers", () => {
    expect(normalizeTicker("$frog ")).toBe("FROG");
    expect(validateTicker("$frog").ok).toBe(true);
    expect(validateTicker("F").ok).toBe(false);
    expect(validateTicker("FROG-1").ok).toBe(false);
    expect(validateTicker("ABCDEFGHIJK").ok).toBe(false);
  });

  it("validates links", () => {
    expect(validateXHandle("@memefun").value).toBe("memefun");
    expect(validateXHandle("https://x.com/memefun").value).toBe("memefun");
    expect(validateXHandle("not a handle!").ok).toBe(false);
    expect(validateTelegram("t.me/memefun_chat").value).toBe("memefun_chat");
    expect(validateWebsite("memefun.wtf").value).toBe("https://memefun.wtf/");
    expect(validateWebsite("http://insecure.example").ok).toBe(false);
    expect(validateDescription("x".repeat(281)).ok).toBe(false);
  });
});

describe("settings", () => {
  it("accepts the defaults", () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });

  it("flags inconsistent settings", () => {
    const keys = validateSettings({ ...DEFAULT_SETTINGS, feeMinBps: 600, defaultFeeBps: 100, enabledModes: [] }).map((issue) => issue.key);
    expect(keys).toContain("feeMinBps");
    expect(keys).toContain("defaultFeeBps");
    expect(keys).toContain("enabledModes");
    expect(validateSettings({ ...DEFAULT_SETTINGS, platformShareBps: 6000 }).map((i) => i.key)).toContain("platformShareBps");
  });

  it("lists changed keys", () => {
    expect(diffSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, platformShareBps: 2500 })).toEqual(["platformShareBps"]);
    expect(diffSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, enabledModes: ["floor", "holders", "burn", "creator"] })).toEqual([]);
  });
});
