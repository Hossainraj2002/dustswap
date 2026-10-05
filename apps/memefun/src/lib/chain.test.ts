import { describe, expect, it } from "vitest";
import { parseChainId } from "./chain";

describe("deployment network setting", () => {
  it("keeps the documented Base default when no network is set", () => {
    expect(parseChainId(undefined)).toBe(8453);
    expect(parseChainId(" ")).toBe(8453);
  });

  it("accepts only supported explicit networks", () => {
    expect(parseChainId("8453")).toBe(8453);
    expect(parseChainId(" 84532 ")).toBe(84532);
    expect(parseChainId("31337")).toBe(31337);
  });

  it("rejects a typo or numeric coercion instead of silently targeting mainnet", () => {
    for (const value of ["84523", "base-sepolia", "NaN", "0", "1", "0x2105", "8.453e3", "8453.0"]) {
      expect(() => parseChainId(value)).toThrow("NEXT_PUBLIC_MEMEFUN_CHAIN_ID");
    }
  });
});
