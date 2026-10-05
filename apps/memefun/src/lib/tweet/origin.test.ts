import { describe, expect, it } from "vitest";
import { sameImportOrigin } from "./origin";

describe("tweet import browser origin", () => {
  it("accepts the actual host when Next uses its local listen address", () => {
    expect(sameImportOrigin(new Request("http://localhost:3112/api/tweets/import", { headers: { host: "127.0.0.1:3112", origin: "http://127.0.0.1:3112" } }))).toBe(true);
  });
  it("accepts the configured HTTPS app behind a proxy", () => {
    expect(sameImportOrigin(new Request("http://localhost:8080/api/tweets/import", { headers: { host: "memefun.dustswap.wtf", origin: "https://memefun.dustswap.wtf" } }), "https://memefun.dustswap.wtf")).toBe(true);
  });
  it("rejects other sites, forged forwarded hosts and malformed origins", () => {
    for (const origin of ["https://evil.test", "null", "https://memefun.dustswap.wtf.evil.test", "https://memefun.dustswap.wtf/path"]) {
      expect(sameImportOrigin(new Request("http://localhost:8080/api/tweets/import", { headers: { host: "memefun.dustswap.wtf", origin, "x-forwarded-host": "evil.test" } }), "https://memefun.dustswap.wtf")).toBe(false);
    }
  });
});
