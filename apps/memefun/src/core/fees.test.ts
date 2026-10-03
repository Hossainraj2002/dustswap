import { describe, expect, it } from "vitest";
import { feeOnAmount, feeOnNet, feeShareFractions, splitFee, type FeeSplitConfig } from "./fees";
import type { FeeMode } from "./types";

describe("feeOnAmount", () => {
  it("rounds up so the fee is never under-collected", () => {
    expect(feeOnAmount(0n, 100)).toBe(0n);
    expect(feeOnAmount(1n, 100)).toBe(1n);
    expect(feeOnAmount(10_000n, 100)).toBe(100n);
    expect(feeOnAmount(10_001n, 100)).toBe(101n);
    expect(feeOnAmount(10n ** 18n, 250)).toBe(25n * 10n ** 15n);
  });

  it("rejects invalid inputs", () => {
    expect(() => feeOnAmount(1n, -1)).toThrow(RangeError);
    expect(() => feeOnAmount(1n, 10_001)).toThrow(RangeError);
    expect(() => feeOnAmount(-1n, 100)).toThrow(RangeError);
  });
});

describe("splitFee", () => {
  const burn: FeeSplitConfig = { mode: "burn", platformShareBps: 2000, referralShareBps: 2500, creatorKeepBps: 5000 };

  it("splits a worked example exactly", () => {
    expect(splitFee(10_000n, burn, true)).toEqual({
      total: 10_000n,
      platform: 1_500n,
      referral: 500n,
      creator: 4_000n,
      destination: 4_000n,
    });
    expect(splitFee(10_000n, burn, false)).toEqual({
      total: 10_000n,
      platform: 2_000n,
      referral: 0n,
      creator: 4_000n,
      destination: 4_000n,
    });
  });

  it("creator mode sends the whole non-platform share to the creator", () => {
    const split = splitFee(1_000_003n, { ...burn, mode: "creator" }, false);
    expect(split.destination).toBe(0n);
    expect(split.platform + split.creator).toBe(1_000_003n);
  });

  it("conserves every wei across random fees, shares and modes", () => {
    const modes: FeeMode[] = ["creator", "burn", "holders", "floor"];
    let seed = 7;
    const rand = (max: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % (max + 1);
    };
    for (let i = 0; i < 5000; i += 1) {
      const fee = BigInt(rand(2_000_000_000)) * BigInt(rand(1_000_000_000)) + BigInt(rand(1000));
      const config: FeeSplitConfig = {
        mode: modes[rand(3)] as FeeMode,
        platformShareBps: rand(10_000),
        referralShareBps: rand(10_000),
        creatorKeepBps: rand(10_000),
      };
      const split = splitFee(fee, config, rand(1) === 1);
      expect(split.platform + split.referral + split.creator + split.destination).toBe(fee);
      for (const part of [split.platform, split.referral, split.creator, split.destination]) {
        expect(part >= 0n).toBe(true);
      }
    }
  });
});

describe("feeShareFractions", () => {
  it("sums to one", () => {
    const fractions = feeShareFractions({ mode: "holders", platformShareBps: 2000, referralShareBps: 2500, creatorKeepBps: 3000 }, true);
    const sum = fractions.platform + fractions.referral + fractions.creator + fractions.destination;
    expect(sum).toBeCloseTo(1, 12);
    expect(fractions.referral).toBeCloseTo(0.05, 12);
  });
});

describe("feeOnNet", () => {
  it("grosses up so the fee is the rate of net plus fee, rounded up and minimal", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const net = BigInt(next()) * BigInt(next()) + BigInt(i);
      const bps = next() % 9_901; // up to the 99% launch-protection cap
      const fee = feeOnNet(net, bps);
      // fee / (net + fee) >= bps / 10_000
      expect(fee * 10_000n >= BigInt(bps) * (net + fee)).toBe(true);
      // and one wei less would fall short (minimality), unless the fee is already zero
      if (fee > 0n) expect((fee - 1n) * 10_000n < BigInt(bps) * (net + fee - 1n)).toBe(true);
    }
  });

  it("is zero at a zero rate and rejects a 100% rate", () => {
    expect(feeOnNet(123_456n, 0)).toBe(0n);
    expect(() => feeOnNet(1n, 10_000)).toThrow(RangeError);
  });

  it("matches known values", () => {
    expect(feeOnNet(9_900n, 100)).toBe(100n); // 1% of 10,000
    expect(feeOnNet(1n, 5_000)).toBe(1n); // 50% protection on 1 wei
    expect(feeOnNet(10n ** 18n, 9_900)).toBe(99n * 10n ** 18n); // 99%: net 1 means gross 100
  });
});
