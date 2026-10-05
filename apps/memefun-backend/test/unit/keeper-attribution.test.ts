import { afterEach, describe, expect, it, vi } from "vitest";
import { Attribution } from "ox/erc8021";
import { createWalletClient, custom, encodeFunctionData, parseAbi, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { BUILDER_CODE, DATA_SUFFIX, keeperAttribution } from "../../keeper/builderCode";
import type { KeeperContext } from "../../keeper/context";
import { simulateAndSend } from "../../keeper/tx";

const USER = "0x00000000000000000000000000000000000000aa" as const;
const TARGET = "0x00000000000000000000000000000000000000bb" as const;
const HASH = `0x${"12".repeat(32)}` as const;
const abi = parseAbi(["function setManualPrice(address quote,uint256 price)"]);
const call = { address: TARGET, abi, functionName: "setManualPrice", args: [TARGET, 100n] } as const;
const aliases = ["MEMEFUN_BUILDER_CODE", "BUILDER_CODE", "BASE_BUILDER_CODE", "NEXT_PUBLIC_BUILDER_CODE", "NEXT_PUBLIC_BASE_BUILDER_CODE"];

afterEach(() => vi.unstubAllEnvs());

describe("keeper builder attribution", () => {
  it("uses the same canonical ERC-8021 code and accepts matching aliases", () => {
    for (const name of aliases) vi.stubEnv(name, BUILDER_CODE);
    expect(keeperAttribution()).toEqual({ value: DATA_SUFFIX, required: true });
    expect(Attribution.fromData(DATA_SUFFIX)?.codes).toEqual(["bc_tpolfjho"]);
  });

  it.each(aliases)("rejects mismatched %s even when other aliases match", name => {
    for (const alias of aliases) vi.stubEnv(alias, BUILDER_CODE);
    vi.stubEnv(name, "bc_another_builder");
    expect(keeperAttribution).toThrow(`${name} must match DustSwap's builder code`);
  });

  it("places one canonical suffix on actual transaction bytes even if the injected sender has another default", async () => {
    const rpc = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
      if (method === "eth_chainId") return "0x14a34";
      if (method === "eth_sendTransaction") return HASH;
      throw new Error(`Unexpected RPC ${method}`);
    });
    const wallet = createWalletClient({ account: USER, chain: baseSepolia, transport: custom({ request: rpc }), dataSuffix: "0x1234" });
    const ctx = { dryRun: false, client: { simulateContract: async (request: unknown) => ({ request, result: 7n }),
      waitForTransactionReceipt: async () => ({ status: "success" }) } } as unknown as KeeperContext;
    await expect(simulateAndSend(ctx, wallet, call)).resolves.toEqual({ kind: "sent", hash: HASH, result: 7n });
    const [request] = rpc.mock.calls.find(([request]) => request.method === "eth_sendTransaction")![0].params as Array<{ data: Hex }>;
    expect(request!.data).toBe(`${encodeFunctionData({ abi, functionName: "setManualPrice", args: [TARGET, 100n] })}${DATA_SUFFIX.slice(2)}`);
    expect(Attribution.fromData(request!.data)?.codes).toEqual([BUILDER_CODE]);
  });

  it("does not sign or submit in dry-run mode", async () => {
    const write = vi.fn();
    const wallet = { account: { address: USER }, writeContract: write } as never;
    const ctx = { dryRun: true, client: { simulateContract: async () => ({ request: call, result: 7n }) } } as unknown as KeeperContext;
    await expect(simulateAndSend(ctx, wallet, call)).resolves.toEqual({ kind: "dry_run", result: 7n });
    expect(write).not.toHaveBeenCalled();
  });
});
