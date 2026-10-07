import { describe, expect, it, vi } from "vitest";
import { createWalletClient, custom, encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbiParameters, zeroAddress, type Hex } from "viem";
import { Attribution } from "ox/erc8021";
import { baseSepolia } from "viem/chains";
import { BUILDER_CODE, DATA_SUFFIX } from "@/lib/wallet/builderCode";
import { withBuilderAttribution } from "@/lib/wallet/attributedWallet";
import { memeFunHookAbi, memeFunRouterAbi } from "@/lib/contracts/abis";
import { sendCreatorAction, sendTrade, type TxContext } from "./tx";

const USER = "0x00000000000000000000000000000000000000aa" as const;
const COIN = "0x00000000000000000000000000000000000000bb" as const;
const HASH = `0x${"12".repeat(32)}` as const;
const BATCH = `0x${"34".repeat(32)}`;
interface RpcCall { method: string; params?: unknown }
interface Scenario { code?: Hex; supportsSuffix?: boolean; emptyCapabilities?: boolean; smartAccount?: boolean; legacy?: boolean; batchError?: unknown; statusError?: unknown; status?: number; receiptStatus?: string; receipts?: boolean; chainId?: string; atomic?: { status?: string; supported?: boolean } }

function context(scenario: Scenario = {}) {
  const rpc = vi.fn(async ({ method }: RpcCall) => {
    if (method === "eth_chainId") return "0x14a34";
    if (method === "eth_sendTransaction") return HASH;
    if (method === "wallet_getCapabilities") {
      if (scenario.legacy) throw { code: -32601, message: "Method not found" };
      if (scenario.emptyCapabilities) return {};
      return { "0x14a34": { dataSuffix: { supported: scenario.supportsSuffix ?? true }, atomic: scenario.atomic ?? { status: "unsupported" } } };
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
  const wallet = withBuilderAttribution(createWalletClient({ account: USER, chain: baseSepolia, transport: custom({ request: rpc }, { retryCount: 0 }) }), { requiresWalletAttribution: scenario.smartAccount });
  const getCode = vi.fn(async () => scenario.code ?? "0x");
  const waitReceipt = vi.fn(async () => ({ status: "success", transactionHash: HASH, blockNumber: 1n, logs: [] }));
  const onStage = vi.fn();
  const ctx = { wallet, onStage,
    client: { simulateContract: async (request: unknown) => ({ request }), getCode, waitForTransactionReceipt: waitReceipt },
    deployment: { hook: USER, router: USER } } as unknown as TxContext;
  return { ctx, rpc, getCode, waitReceipt, onStage };
}

describe("attributed contract transaction routing", () => {
  it("routes a smart-wallet action through required wallet-side attribution and resolves its transaction hash", async () => {
    const { ctx, rpc, getCode, waitReceipt, onStage } = context({ code: "0x1234", smartAccount: true });
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).resolves.toBe(HASH);
    const sent = rpc.mock.calls.find(([call]) => call.method === "wallet_sendCalls")![0];
    const [batch] = sent.params as Array<{ calls: Array<{ data: Hex }>; capabilities: Record<string, unknown>; atomicRequired: boolean }>;
    expect(batch!.calls[0]!.data).toBe(encodeFunctionData({ abi: memeFunHookAbi, functionName: "acceptCreator", args: [COIN] }));
    expect(batch!.capabilities.dataSuffix).toEqual({ value: DATA_SUFFIX });
    expect(batch!.atomicRequired).toBe(false);
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

  it.each(["0x1234", "0xef0100", `0xef0100${"11".repeat(19)}`, `0xef0100${"11".repeat(21)}`, `0x00ef0100${"11".repeat(20)}`] as Hex[])("blocks ordinary contract code %s without dataSuffix support", async code => {
    const { ctx, rpc } = context({ supportsSuffix: false, code });
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).rejects.toThrow("required transaction attribution");
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction" || call.method === "wallet_sendCalls")).toBe(false);
  });

  it.each([
    { label: "atomic-ready EOA", code: "0x", atomic: { status: "ready" } },
    { label: "atomic-supported EOA", code: "0x", atomic: { status: "supported" } },
    { label: "legacy atomic-supported EOA", code: "0x", atomic: { supported: true } },
    { label: "delegated EOA", code: `0xef0100${"11".repeat(20)}`, atomic: { status: "supported" } },
  ])("executes a buy from an $label with the builder code in transaction calldata", async ({ code, atomic }) => {
    const { ctx, rpc, getCode, waitReceipt } = context({ supportsSuffix: false, code: code as Hex, atomic });
    const amountIn = 100_000_000_000_000n; // The screenshot's 0.0001 ETH trade.
    const minAmountOut = 1n;
    const deadline = 10_000n;
    const poolId = `0x${"01".repeat(32)}` as Hex;
    const topics = encodeEventTopics({ abi: memeFunHookAbi, eventName: "Trade", args: { id: poolId, coin: COIN, trader: USER } });
    const data = encodeAbiParameters(parseAbiParameters("bool isBuy,uint256 quoteAmount,uint256 coinAmount,uint256 fee,uint256 feeBps,address referrer,uint160 sqrtPriceX96,int24 tick"),
      [true, amountIn, 1_000n, amountIn / 100n, 100n, zeroAddress, 2n ** 96n, 0]);
    waitReceipt.mockResolvedValueOnce({ status: "success", transactionHash: HASH, blockNumber: 1n, logs: [{ address: USER, topics, data }] } as never);

    await expect(sendTrade(ctx, { side: "buy", coin: COIN, quote: zeroAddress, amountIn, minAmountOut, deadline })).resolves.toMatchObject({ hash: HASH, isBuy: true });
    expect(getCode).toHaveBeenCalledWith({ address: USER });
    const transactions = rpc.mock.calls.filter(([call]) => call.method === "eth_sendTransaction");
    expect(transactions).toHaveLength(1);
    const [transaction] = transactions[0]![0].params as Array<{ from: string; to: string; value: Hex; data: Hex }>;
    const calldata = encodeFunctionData({ abi: memeFunRouterAbi, functionName: "buy", args: [{ coin: COIN, amountIn, minAmountOut, recipient: zeroAddress, referrer: zeroAddress, deadline }] });
    expect(transaction).toMatchObject({ from: USER, to: USER, value: "0x5af3107a4000", data: `${calldata}${DATA_SUFFIX.slice(2)}` });
    expect(Attribution.fromData(transaction!.data)?.codes).toEqual([BUILDER_CODE]);
    expect(rpc.mock.calls.some(([call]) => call.method === "wallet_sendCalls")).toBe(false);
  });

  it.each(["0x", `0xef0100${"11".repeat(20)}`] as Hex[])("uses mandatory wallet-side attribution for a known smart provider with missing cached capabilities and code %s", async code => {
    const { ctx, rpc, getCode } = context({ emptyCapabilities: true, smartAccount: true, code });
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).resolves.toBe(HASH);
    expect(getCode).not.toHaveBeenCalled();
    const sent = rpc.mock.calls.filter(([call]) => call.method === "wallet_sendCalls");
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].params).toEqual([expect.objectContaining({ capabilities: { dataSuffix: { value: DATA_SUFFIX } }, calls: [{ to: USER, data: encodeFunctionData({ abi: memeFunHookAbi, functionName: "acceptCreator", args: [COIN] }) }], atomicRequired: false })]);
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction")).toBe(false);
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
    { label: "explicitly unsupported required attribution", scenario: { emptyCapabilities: true, smartAccount: true, batchError: { code: 5700, message: "Unsupported non-optional capability" } }, message: "does not support the required Base builder attribution" },
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
