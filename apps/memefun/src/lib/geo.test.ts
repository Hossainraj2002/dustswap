import { describe, expect, it } from "vitest";
import { isStockRestrictedCountry, readCountryCookie } from "./geo";

describe("stock pair geofence", () => {
  it("closes the US and its territories only", () => {
    for (const country of ["US", "us", "PR", "GU", "VI", "AS", "MP", "UM"]) expect(isStockRestrictedCountry(country)).toBe(true);
    for (const country of ["BD", "GB", "DE", "CA", "SG", null, undefined, ""]) expect(isStockRestrictedCountry(country)).toBe(false);
  });

  it("reads the middleware's cookie and ignores anything malformed", () => {
    expect(readCountryCookie("theme=dark; mf-country=bd; other=1")).toBe("BD");
    expect(readCountryCookie("mf-country=USA")).toBeNull();
    expect(readCountryCookie("mf-country=")).toBeNull();
    expect(readCountryCookie("")).toBeNull();
  });
});
