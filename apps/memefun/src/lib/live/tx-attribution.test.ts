import { describe, expect, it, vi } from "vitest";
import { createWalletClient, custom, encodeFunctionData, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { DATA_SUFFIX } from "@/lib/wallet/builderCode";
import { withBuilderAttribution } from "@/lib/wallet/attributedWallet";
import { memeFunHookAbi } from "@/lib/contracts/abis";
import { sendCreatorAction, type TxContext } from "./tx";

const USER = "0x00000000000000000000000000000000000000aa" as const;
const COIN = "0x00000000000000000000000000000000000000bb" as const;
const HASH = `0x${"12".repeat(32)}` as const;
const BATCH = `0x${"34".repeat(32)}`;
interface RpcCall { method: string; params?: unknown }
interface Scenario { code?: Hex; supportsSuffix?: boolean; legacy?: boolean; batchError?: unknown; statusError?: unknown; status?: number; receiptStatus?: string; receipts?: boolean; chainId?: string; atomicReady?: boolean }

function context(scenario: Scenario = {}) {
  const rpc = vi.fn(async ({ method }: RpcCall) => {
    if (method === "eth_chainId") return "0x14a34";
    if (method === "eth_sendTransaction") return HASH;
    if (method === "wallet_getCapabilities") {
      if (scenario.legacy) throw { code: -32601, message: "Method not found" };
      return { "0x14a34": { dataSuffix: { supported: scenario.supportsSuffix ?? true }, atomic: { status: scenario.atomicReady ? "ready" : "unsupported" } } };
    }
    if (method === "wallet_sendCalls") {
      if (scenario.batchError) throw scenario.batchError;
      return { id: BATCH };
    }
    if (method === "wallet_getCallsStatus") {
      if (scenario.statusError) throw scenario.statusError;
      return { version: "2.0.0", atomic: true, chainId: scenario.chainId ?? "0x14a34", status: scenario.status ?? 200,
        receipts: scenario.receipts === false ? [] : [{ transactionHash: HASH, blockNumber: "0x1", gasUsed: "0x5208", status: scenario.receiptStatus ?? "0x1", logs: [] }] };
    }
    throw new Error(`Unexpected RPC method ${method}`);
  });
  const wallet = withBuilderAttribution(createWalletClient({ account: USER, chain: baseSepolia, transport: custom({ request: rpc }, { retryCount: 0 }) }));
  const getCode = vi.fn(async () => scenario.code ?? "0x");
  const waitReceipt = vi.fn(async () => ({ status: "success", transactionHash: HASH, blockNumber: 1n, logs: [] }));
  const onStage = vi.fn();
  const ctx = { wallet, onStage,
    client: { simulateContract: async (request: unknown) => ({ request }), getCode, waitForTransactionReceipt: waitReceipt },
    deployment: { hook: USER } } as unknown as TxContext;
  return { ctx, rpc, getCode, waitReceipt, onStage };
}

describe("attributed contract transaction routing", () => {
  it("routes a smart-wallet action through required wallet-side attribution and resolves its transaction hash", async () => {
    const { ctx, rpc, getCode, waitReceipt, onStage } = context({ code: "0x1234" });
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).resolves.toBe(HASH);
    const sent = rpc.mock.calls.find(([call]) => call.method === "wallet_sendCalls")![0];
    const [batch] = sent.params as Array<{ calls: Array<{ data: Hex }>; capabilities: Record<string, unknown>; atomicRequired: boolean }>;
    expect(batch!.calls[0]!.data).toBe(encodeFunctionData({ abi: memeFunHookAbi, functionName: "acceptCreator", args: [COIN] }));
    expect(batch!.capabilities.dataSuffix).toEqual({ value: DATA_SUFFIX });
    expect(batch!.atomicRequired).toBe(true);
    expect(getCode).not.toHaveBeenCalled();
    expect(waitReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: HASH }));
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(["confirm", "pending", "pending"]);
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction")).toBe(false);
  });

  it("allows an EOA from a legacy provider only after verifying it has no chain code", async () => {
    const { ctx, rpc, getCode } = context({ legacy: true });
    await sendCreatorAction(ctx, COIN, "acceptCreator");
    expect(getCode).toHaveBeenCalledWith({ address: USER });
    const sent = rpc.mock.calls.find(([call]) => call.method === "eth_sendTransaction")![0];
    const [transaction] = sent.params as Array<{ data: Hex }>;
    expect(transaction!.data).toBe(`${encodeFunctionData({ abi: memeFunHookAbi, functionName: "acceptCreator", args: [COIN] })}${DATA_SUFFIX.slice(2)}`);
  });

  it.each(["0x1234", `0xef0100${"11".repeat(20)}`] as Hex[])("blocks a contract/delegated wallet %s without dataSuffix support", async code => {
    const { ctx, rpc } = context({ supportsSuffix: false, code });
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).rejects.toThrow("required transaction attribution");
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction" || call.method === "wallet_sendCalls")).toBe(false);
  });

  it("blocks a counterfactual smart wallet ready for atomic calls without suffix support", async () => {
    const { ctx, rpc, getCode } = context({ supportsSuffix: false, atomicReady: true });
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).rejects.toThrow("required transaction attribution");
    expect(getCode).not.toHaveBeenCalled();
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction" || call.method === "wallet_sendCalls")).toBe(false);
  });

  it("still checks chain code when a minimal external client has no capability method", async () => {
    const { ctx, rpc, getCode } = context({ code: "0x1234" });
    Object.assign(ctx.wallet, { getCapabilities: undefined });
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).rejects.toThrow("required transaction attribution");
    expect(getCode).toHaveBeenCalledWith({ address: USER });
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction" || call.method === "wallet_sendCalls")).toBe(false);
  });

  it("blocks submission when an external wallet's chain code cannot be checked", async () => {
    const { ctx, rpc, getCode } = context({ legacy: true });
    getCode.mockRejectedValueOnce(new Error("RPC disconnected"));
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).rejects.toThrow("could not be checked");
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction" || call.method === "wallet_sendCalls")).toBe(false);
  });

  it.each([
    { label: "user rejection", scenario: { batchError: { code: 4001, message: "User rejected the request" } }, message: "rejected" },
    { label: "unsupported batch", scenario: { batchError: { code: -32601, message: "Method not found" } }, message: "may have been sent" },
    { label: "uncertain submission", scenario: { batchError: new Error("network disconnected") }, message: "may have been sent" },
    { label: "unreadable status", scenario: { statusError: new Error("network disconnected") }, message: "may have been sent" },
    { label: "missing receipt", scenario: { receipts: false }, message: "may have been sent" },
    { label: "failed batch", scenario: { status: 500 }, message: "did not go through" },
    { label: "failed user operation", scenario: { receiptStatus: "0x0" }, message: "did not go through" },
    { label: "another chain's receipt", scenario: { chainId: "0x2105" }, message: "may have been sent" },
  ])("never resends after $label", async ({ scenario, message }) => {
    const { ctx, rpc, waitReceipt } = context(scenario);
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).rejects.toThrow(message);
    expect(rpc.mock.calls.filter(([call]) => call.method === "wallet_sendCalls")).toHaveLength(1);
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction")).toBe(false);
    expect(waitReceipt).not.toHaveBeenCalled();
  });
});
