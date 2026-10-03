import { afterEach, describe, expect, it } from "vitest";

import { chainSettings } from "../../lib/chain";
import { parseDeployment } from "../../lib/deployment";
import { envBool, envInt, envList } from "../../lib/env";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("chainSettings", () => {
  it("defaults to the local chain", () => {
    delete process.env.MEMEFUN_CHAIN;
    delete process.env.MEMEFUN_RPC_URLS;
    expect(chainSettings()).toMatchObject({ key: "local", id: 31337, rpcUrls: ["http://127.0.0.1:8545"] });
  });

  it("requires RPC URLs off the local chain and refuses the public Base RPC for mainnet", () => {
    process.env.MEMEFUN_CHAIN = "base";
    delete process.env.MEMEFUN_RPC_URLS;
    expect(() => chainSettings()).toThrow("MEMEFUN_RPC_URLS is required");
    process.env.MEMEFUN_RPC_URLS = "https://mainnet.base.org";
    expect(() => chainSettings()).toThrow("paid endpoints");
    process.env.MEMEFUN_RPC_URLS = "https://base-mainnet.g.alchemy.com/v2/key-a, https://base-mainnet.g.alchemy.com/v2/key-b";
    expect(chainSettings()).toMatchObject({ id: 8453, rpcUrls: ["https://base-mainnet.g.alchemy.com/v2/key-a", "https://base-mainnet.g.alchemy.com/v2/key-b"] });
  });

  it("rejects unknown chains", () => {
    process.env.MEMEFUN_CHAIN = "mainnet";
    expect(() => chainSettings()).toThrow("MEMEFUN_CHAIN must be one of");
  });
});

describe("parseDeployment", () => {
  const record = {
    chainId: 84532,
    deployedAtBlock: 10,
    poolManager: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408",
    config: "0x0000000000000000000000000000000000000002",
    feeVault: "0x0000000000000000000000000000000000000003",
    factory: "0x0000000000000000000000000000000000000004",
    router: "0x0000000000000000000000000000000000000005",
    hook: "0x0000000000000000000000000000000000000006",
    buybackBurnVault: "0x0000000000000000000000000000000000000007",
    floorVault: "0x0000000000000000000000000000000000000008",
    holderRewardDistributor: "0x0000000000000000000000000000000000000009",
    ethUsdFeed: "0x000000000000000000000000000000000000000a",
    usdc: "0x000000000000000000000000000000000000000b",
    owner: "0x000000000000000000000000000000000000000c",
    treasury: "0x000000000000000000000000000000000000000d",
    priceKeeper: "0x0000000000000000000000000000000000000000",
    rewardsPublisher: "0x0000000000000000000000000000000000000000",
  };

  it("checksums addresses and checks the chain", () => {
    const d = parseDeployment(record, 84532);
    expect(d.poolManager).toBe("0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408");
    expect(() => parseDeployment(record, 8453)).toThrow("expected 8453");
  });

  it("refuses a record with a bad address", () => {
    expect(() => parseDeployment({ ...record, hook: "0x1234" })).toThrow();
  });
});

describe("env helpers", () => {
  it("parse lists, booleans and bounded integers", () => {
    process.env.T_LIST = " a, b  c ,";
    process.env.T_BOOL = "yes";
    process.env.T_INT = "42";
    expect(envList("T_LIST")).toEqual(["a", "b", "c"]);
    expect(envBool("T_BOOL", false)).toBe(true);
    expect(envBool("T_MISSING", true)).toBe(true);
    expect(envInt("T_INT", 0, { max: 100 })).toBe(42);
    expect(() => envInt("T_INT", 0, { max: 10 })).toThrow("at most 10");
    process.env.T_BOOL = "maybe";
    expect(() => envBool("T_BOOL", false)).toThrow();
  });
});
