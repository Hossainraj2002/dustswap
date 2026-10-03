import { describe, expect, it } from "vitest";
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  Q96,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  maxUsableTick,
  minUsableTick,
} from "./tickMath";

// Reference values from Uniswap v3-core's TickMath test suite (v4 is identical).
describe("getSqrtPriceAtTick", () => {
  it("matches the Uniswap reference values", () => {
    expect(getSqrtPriceAtTick(0)).toBe(Q96);
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(getSqrtPriceAtTick(MIN_TICK + 1)).toBe(4295343490n);
    expect(getSqrtPriceAtTick(MAX_TICK - 1)).toBe(1461373636630004318706518188784493106690254656249n);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
  });

  it("rejects ticks outside the range and non-integers", () => {
    expect(() => getSqrtPriceAtTick(MIN_TICK - 1)).toThrow(RangeError);
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => getSqrtPriceAtTick(1.5)).toThrow(RangeError);
  });

  it("agrees with sqrt(1.0001^tick) for random ticks across every bit", () => {
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i += 1) {
      const tick = Math.round(MIN_TICK + next() * (MAX_TICK - MIN_TICK));
      const exact = Number(getSqrtPriceAtTick(tick)) / Number(Q96);
      const expected = Math.exp((tick * Math.log(1.0001)) / 2);
      expect(Math.abs(exact / expected - 1)).toBeLessThan(1e-9);
    }
  });

  it("is strictly increasing", () => {
    let previous = getSqrtPriceAtTick(-1000);
    for (let tick = -999; tick <= 1000; tick += 1) {
      const current = getSqrtPriceAtTick(tick);
      expect(current > previous).toBe(true);
      previous = current;
    }
  });
});

describe("getTickAtSqrtPrice", () => {
  it("inverts getSqrtPriceAtTick exactly", () => {
    for (const tick of [MIN_TICK, -887000, -200000, -201, -1, 0, 1, 199, 200, 202000, 398400, MAX_TICK - 1]) {
      const price = getSqrtPriceAtTick(tick);
      expect(getTickAtSqrtPrice(price)).toBe(tick);
      if (tick < MAX_TICK - 1) {
        // Any price strictly between two ticks maps to the lower tick.
        expect(getTickAtSqrtPrice(price + 1n)).toBe(tick);
      }
    }
  });
});

describe("usable ticks", () => {
  it("aligns to the spacing inside the range", () => {
    expect(minUsableTick(200)).toBe(-887200);
    expect(maxUsableTick(200)).toBe(887200);
    expect(minUsableTick(60)).toBe(-887220);
    expect(maxUsableTick(60)).toBe(887220);
  });
});
