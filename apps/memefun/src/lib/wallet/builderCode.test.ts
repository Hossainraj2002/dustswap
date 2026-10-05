import { afterEach, describe, expect, it, vi } from "vitest";
import { Attribution } from "ox/erc8021";
import { appendBuilderCodeToData, BUILDER_CODE, DATA_SUFFIX } from "./builderCode";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("DustSwap builder attribution", () => {
  it("encodes the registered DustSwap code as a decodable ERC-8021 suffix", () => {
    expect(BUILDER_CODE).toBe("bc_tpolfjho");
    expect(Attribution.fromData(DATA_SUFFIX)?.codes).toEqual([BUILDER_CODE]);
  });

  it("attributes value-only transfers and does not duplicate already attributed calldata", () => {
    expect(appendBuilderCodeToData()).toBe(DATA_SUFFIX);
    const data = appendBuilderCodeToData("0x1234");
    expect(data).toBe(`0x1234${DATA_SUFFIX.slice(2)}`);
    expect(appendBuilderCodeToData(data)).toBe(data);
    expect(appendBuilderCodeToData(data.toUpperCase().replace("0X", "0x") as `0x${string}`)).toBe(data.toUpperCase().replace("0X", "0x"));
  });

  it.each(["0x1", "0xzz", "1234"])("rejects malformed transaction bytes %s", data => {
    expect(() => appendBuilderCodeToData(data as `0x${string}`)).toThrow("hexadecimal bytes");
  });

  it.each(["NEXT_PUBLIC_BUILDER_CODE", "NEXT_PUBLIC_BASE_BUILDER_CODE"])("rejects a mismatched %s deploy variable", async variable => {
    vi.stubEnv("NEXT_PUBLIC_BUILDER_CODE", "");
    vi.stubEnv("NEXT_PUBLIC_BASE_BUILDER_CODE", "");
    vi.stubEnv(variable, "bc_another_builder");
    vi.resetModules();
    await expect(import("./builderCode")).rejects.toThrow("must use DustSwap's builder code");
  });
});
