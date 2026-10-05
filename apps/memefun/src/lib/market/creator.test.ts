import { describe, expect, it } from "vitest";
import { parseFeePercent } from "./creator";

describe("creator fee percent", () => {
  it.each([["0.29", 29], ["1.01", 101], ["0", 0], ["0.00", 0], ["2.5", 250], [" 0.10 ", 10]])("parses %s exactly", (value, expected) => {
    expect(parseFeePercent(String(value))).toBe(expected);
  });
  it.each(["", ".", "0.001", "1e2", "-1", "NaN", "101", "1."])("rejects invalid percent %s", (value) => {
    expect(parseFeePercent(value)).toBeNull();
  });
});
