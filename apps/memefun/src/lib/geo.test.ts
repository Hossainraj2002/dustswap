import { describe, expect, it } from "vitest";
import { isStockRestrictedCountry, readCountryCookie, trustedStockCountry } from "./geo";

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
  it("requires a known eligible country for mainnet stock access while testnet remains usable", () => {
    for (const country of [null, undefined, "", "USA", "XX", "T1"]) expect(isStockRestrictedCountry(country, true)).toBe(true);
    for (const country of ["BD", "GB", "DE"]) expect(isStockRestrictedCountry(country, true)).toBe(false);
    expect(isStockRestrictedCountry(null, false)).toBe(false);
    expect(isStockRestrictedCountry("US", true)).toBe(true);
  });
  it("does not trust geographic headers on alternate origins or requests without Cloudflare context", () => {
    const request = { hostname: "memefun.dustswap.wtf", appUrl: "https://memefun.dustswap.wtf", cfRay: "9af123456789abcd-DAC", country: "bd" };
    expect(trustedStockCountry(request)).toBe("BD");
    expect(trustedStockCountry({ ...request, hostname: "memefun-web.up.railway.app" })).toBeNull();
    expect(trustedStockCountry({ ...request, cfRay: null })).toBeNull();
    expect(trustedStockCountry({ ...request, country: "XX" })).toBeNull();
  });
});
