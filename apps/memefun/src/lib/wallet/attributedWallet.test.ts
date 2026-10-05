import { describe, expect, it, vi } from "vitest";
import { createWalletClient, custom, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { Attribution } from "ox/erc8021";
import { withBuilderAttribution } from "./attributedWallet";
import { BUILDER_CODE, DATA_SUFFIX } from "./builderCode";
import { buildBasePaymasterCapabilities } from "./paymaster";

const USER = "0x00000000000000000000000000000000000000aa" as const;
const TOKEN = "0x00000000000000000000000000000000000000bb" as const;
const HASH = `0x${"12".repeat(32)}` as const;
interface RpcCall { method: string; params?: unknown }

function context(unsupportedBatch = false) {
  const rpc = vi.fn(async ({ method }: RpcCall) => {
    if (method === "eth_chainId") return "0x14a34";
    if (method === "eth_sendTransaction") return HASH;
    if (method === "eth_signTypedData_v4") return `0x${"34".repeat(65)}`;
    if (method === "wallet_sendCalls") {
      if (unsupportedBatch) throw { code: -32601, message: "Method not found" };
      return { id: "batch-id" };
    }
    throw new Error(`Unexpected RPC method ${method}`);
  });
  const original = createWalletClient({ account: USER, chain: baseSepolia, transport: custom({ request: rpc }) });
  return { rpc, wallet: withBuilderAttribution(original) };
}

describe("connected wallet attribution on the wire", () => {
  it("adds the code to a value-only transfer without a per-transaction suffix", async () => {
    const { wallet, rpc } = context();
    await wallet.sendTransaction({ account: USER, chain: baseSepolia, to: TOKEN, value: 1n });
    const call = rpc.mock.calls.find(([call]) => call.method === "eth_sendTransaction")![0];
    const [sent] = call.params as Array<{ data: Hex }>;
    expect(sent!.data).toBe(DATA_SUFFIX);
    expect(Attribution.fromData(sent!.data)?.codes).toEqual([BUILDER_CODE]);
  });

  it("appends exactly one suffix to approvals when the transaction also supplies it", async () => {
    const { wallet, rpc } = context();
    await wallet.writeContract({ account: USER, chain: baseSepolia, address: TOKEN, abi: erc20Abi, functionName: "approve", args: [USER, 123n], dataSuffix: DATA_SUFFIX });
    const call = rpc.mock.calls.find(([call]) => call.method === "eth_sendTransaction")![0];
    const [sent] = call.params as Array<{ data: Hex }>;
    const approval = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [USER, 123n] });
    expect(sent!.data).toBe(`${approval}${DATA_SUFFIX.slice(2)}`);
    expect(Attribution.fromData(sent!.data)?.codes).toEqual([BUILDER_CODE]);
  });

  it("requires wallet-side attribution on a batch instead of silently allowing omission", async () => {
    const { wallet, rpc } = context();
    await wallet.sendCalls({ account: USER, chain: baseSepolia, calls: [{ to: TOKEN, data: "0x1234" }, { to: TOKEN, value: 1n }] });
    const call = rpc.mock.calls.find(([call]) => call.method === "wallet_sendCalls")![0];
    const [sent] = call.params as Array<{ capabilities: Record<string, unknown>; calls: Array<{ data?: Hex }> }>;
    expect(sent!.capabilities.dataSuffix).toEqual({ value: DATA_SUFFIX });
    // Wallets append the suffix to the outer transaction/user operation, not inner ABI calls.
    expect(sent!.calls[0]!.data).toBe("0x1234");
    expect(buildBasePaymasterCapabilities().dataSuffix).toEqual({ value: DATA_SUFFIX });
  });

  it("does not fall back to unattributed transactions when a batch capability is unsupported", async () => {
    const { wallet, rpc } = context(true);
    await expect(wallet.sendCalls({ account: USER, chain: baseSepolia, calls: [{ to: TOKEN, value: 1n }], experimental_fallback: true })).rejects.toThrow("non-optional");
    expect(rpc.mock.calls.some(([call]) => call.method === "eth_sendTransaction")).toBe(false);
  });

  it("preserves offchain typed signatures without appending transaction bytes", async () => {
    const { wallet, rpc } = context();
    await wallet.signTypedData({ account: USER, domain: { chainId: baseSepolia.id }, types: { Example: [{ name: "value", type: "uint256" }] }, primaryType: "Example", message: { value: 123n } });
    const call = rpc.mock.calls.find(([call]) => call.method === "eth_signTypedData_v4")![0];
    const [, typedJson] = call.params as string[];
    expect(JSON.parse(typedJson!).message).toEqual({ value: "123" });
    expect(typedJson).not.toContain(DATA_SUFFIX.slice(2));
  });
});
