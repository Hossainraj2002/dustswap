import { describe, expect, it, vi } from "vitest";
import { createWalletClient, custom, encodeFunctionData, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { Attribution } from "ox/erc8021";
import type { LaunchCampaignClaimTicket, LaunchCampaignSummary } from "@/core/campaign";
import { withBuilderAttribution } from "@/lib/wallet/attributedWallet";
import { BUILDER_CODE, DATA_SUFFIX } from "@/lib/wallet/builderCode";
import { launchCampaignAbi, sendLaunchCampaignClaim, type TxContext } from "./tx";

const USER = "0x00000000000000000000000000000000000000aa" as const;
const OTHER = "0x00000000000000000000000000000000000000bb" as const;
const DISTRIBUTOR = "0x00000000000000000000000000000000000000cc" as const;
const COIN = "0x00000000000000000000000000000000000000dd" as const;
const HASH = `0x${"12".repeat(32)}` as const;
const BATCH = `0x${"34".repeat(32)}`;
const TICKET: LaunchCampaignClaimTicket = {
  wallet: USER, slot: 0, coin: COIN, launchBlock: "101", tradeBlock: "0", deadline: 2_000_000_000,
  signature: `0x${"11".repeat(65)}`,
};
const SUMMARY: Extract<LaunchCampaignSummary, { enabled: true }> = {
  enabled: true, chainId: baseSepolia.id, contract: DISTRIBUTOR,
  token: { address: OTHER, name: "Campaign token", symbol: "MFT", decimals: 18 },
  rewardAmountRaw: "1000000000000000000", maxRecipients: 1000, claimedCount: 0, qualifiedCount: 1,
  startBlock: "100", tradeRequiredFromBlock: "0",
};
interface RpcCall { method: string; params?: unknown }
interface Scenario { smart?: boolean; code?: Hex; sendError?: unknown; statusError?: unknown; receiptError?: unknown; receiptStatus?: string }
function context(scenario: Scenario = {}) {
  const rpc = vi.fn(async ({ method }: RpcCall) => {
    if (method === "eth_chainId") return "0x14a34";
    if (method === "wallet_getCapabilities") return {};
    if (method === "eth_sendTransaction") {
      if (scenario.sendError) throw scenario.sendError;
      return HASH;
    }
    if (method === "wallet_sendCalls") {
      if (scenario.sendError) throw scenario.sendError;
      return { id: BATCH };
    }
    if (method === "wallet_getCallsStatus") {
      if (scenario.statusError) throw scenario.statusError;
      return { version: "2.0.0", atomic: true, chainId: "0x14a34", status: 200,
        receipts: [{ transactionHash: HASH, blockNumber: "0x1", gasUsed: "0x5208", status: "0x1", logs: [] }] };
    }
    throw new Error(`Unexpected RPC method ${method}`);
  });
  const wallet = withBuilderAttribution(createWalletClient({ account: USER, chain: baseSepolia,
    transport: custom({ request: rpc }, { retryCount: 0 }) }), { requiresWalletAttribution: scenario.smart });
  const simulate = vi.fn(async (request: unknown) => ({ request }));
  const getCode = vi.fn(async () => scenario.code ?? "0x");
  const waitReceipt = vi.fn(async () => {
    if (scenario.receiptError) throw scenario.receiptError;
    return { status: scenario.receiptStatus ?? "success", transactionHash: HASH, blockNumber: 1n, logs: [] };
  });
  const onStage = vi.fn();
  const ctx = { wallet, onStage, client: { simulateContract: simulate, getCode, waitForTransactionReceipt: waitReceipt },
    deployment: { hook: USER, router: USER } } as unknown as TxContext;
  return { ctx, rpc, simulate, getCode, waitReceipt, onStage };
}
const calldata = (ticket = TICKET) => encodeFunctionData({ abi: launchCampaignAbi, functionName: "claim",
  args: [ticket.wallet, ticket.slot, ticket.coin, BigInt(ticket.launchBlock), BigInt(ticket.tradeBlock), BigInt(ticket.deadline), ticket.signature] });
const submissions = (rpc: ReturnType<typeof context>["rpc"]) => rpc.mock.calls.filter(([call]) => call.method === "eth_sendTransaction" || call.method === "wallet_sendCalls");

describe("attributed fixed-wallet campaign claims", () => {
  it.each([0, 999])("uses the flat ABI for slot %s and appends the registered EOA attribution exactly once", async slot => {
    const ticket = { ...TICKET, slot };
    const { ctx, rpc, simulate, waitReceipt, onStage } = context();
    await expect(sendLaunchCampaignClaim(ctx, SUMMARY, ticket)).resolves.toBe(HASH);
    expect(simulate).toHaveBeenCalledWith(expect.objectContaining({ account: ctx.wallet.account, address: DISTRIBUTOR,
      functionName: "claim", args: [USER, slot, COIN, 101n, 0n, 2_000_000_000n, TICKET.signature] }));
    expect(submissions(rpc)).toHaveLength(1);
    const call = submissions(rpc)[0]![0];
    expect(call.method).toBe("eth_sendTransaction");
    const [transaction] = call.params as Array<{ from: string; to: string; data: Hex; value?: Hex }>;
    expect(transaction).toMatchObject({ from: USER, to: DISTRIBUTOR, data: `${calldata(ticket)}${DATA_SUFFIX.slice(2)}` });
    expect(transaction!.value ?? "0x0").toBe("0x0");
    expect(Attribution.fromData(transaction!.data)?.codes).toEqual([BUILDER_CODE]);
    expect(waitReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: HASH }));
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(["confirm", "pending"]);
  });

  it("routes an undeployed smart wallet through mandatory wallet-side attribution without a fallback", async () => {
    const { ctx, rpc, getCode, waitReceipt } = context({ smart: true });
    await expect(sendLaunchCampaignClaim(ctx, SUMMARY, TICKET)).resolves.toBe(HASH);
    expect(getCode).not.toHaveBeenCalled();
    expect(submissions(rpc)).toHaveLength(1);
    const call = submissions(rpc)[0]![0];
    expect(call.method).toBe("wallet_sendCalls");
    expect(call.params).toEqual([expect.objectContaining({
      calls: [{ to: DISTRIBUTOR, data: calldata() }],
      capabilities: { dataSuffix: { value: DATA_SUFFIX } }, atomicRequired: false,
    })]);
    expect(waitReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: HASH }));
  });

  it("keeps qualifying block numbers exact beyond JavaScript number precision", async () => {
    const { ctx, simulate } = context();
    const ticket = { ...TICKET, launchBlock: "9007199254740993", tradeBlock: "9007199254740994" };
    await sendLaunchCampaignClaim(ctx, SUMMARY, ticket);
    expect(simulate).toHaveBeenCalledWith(expect.objectContaining({ args: [USER, 0, COIN, 9007199254740993n, 9007199254740994n, 2_000_000_000n, TICKET.signature] }));
  });

  it.each([
    { label: "another wallet", ticket: { ...TICKET, wallet: OTHER } },
    { label: "negative slot", ticket: { ...TICKET, slot: -1 } },
    { label: "slot outside first 1000", ticket: { ...TICKET, slot: 1000 } },
    { label: "fractional slot", ticket: { ...TICKET, slot: 0.5 } },
    { label: "negative launch block", ticket: { ...TICKET, launchBlock: "-1" } },
    { label: "fractional trade block", ticket: { ...TICKET, tradeBlock: "102.5" } },
    { label: "zero deadline", ticket: { ...TICKET, deadline: 0 } },
    { label: "unsafe deadline", ticket: { ...TICKET, deadline: Number.MAX_SAFE_INTEGER + 1 } },
  ])("refuses $label before simulation or wallet submission", async ({ ticket }) => {
    const { ctx, rpc, simulate } = context();
    await expect(sendLaunchCampaignClaim(ctx, SUMMARY, ticket)).rejects.toThrow("does not match the connected wallet or campaign");
    expect(simulate).not.toHaveBeenCalled();
    expect(submissions(rpc)).toHaveLength(0);
  });

  it("refuses a campaign from a different chain before asking the wallet", async () => {
    const { ctx, rpc, simulate } = context();
    await expect(sendLaunchCampaignClaim(ctx, { ...SUMMARY, chainId: 8453 }, TICKET)).rejects.toThrow("does not match");
    expect(simulate).not.toHaveBeenCalled();
    expect(submissions(rpc)).toHaveLength(0);
  });

  it("does not ask the wallet after a simulation reverts", async () => {
    const { ctx, rpc, simulate } = context();
    simulate.mockRejectedValueOnce(new Error("Campaign is disabled"));
    await expect(sendLaunchCampaignClaim(ctx, SUMMARY, TICKET)).rejects.toThrow("launch reward could not be claimed");
    expect(submissions(rpc)).toHaveLength(0);
  });

  it("rejects a caller-provided attribution override before submission", async () => {
    const { ctx, rpc } = context();
    ctx.dataSuffix = "0x1234";
    await expect(sendLaunchCampaignClaim(ctx, SUMMARY, TICKET)).rejects.toThrow("builder code does not match DustSwap");
    expect(submissions(rpc)).toHaveLength(0);
  });

  it("blocks ordinary contract wallets that cannot attach attribution", async () => {
    const { ctx, rpc } = context({ code: "0x1234" });
    await expect(sendLaunchCampaignClaim(ctx, SUMMARY, TICKET)).rejects.toThrow("required transaction attribution");
    expect(submissions(rpc)).toHaveLength(0);
  });

  it.each([
    { label: "user rejection", scenario: { smart: true, sendError: { code: 4001, message: "User rejected" } }, message: "rejected" },
    { label: "uncertain smart-wallet submission", scenario: { smart: true, sendError: new Error("network unavailable") }, message: "may have been sent" },
    { label: "unreadable smart-wallet status", scenario: { smart: true, statusError: new Error("network unavailable") }, message: "may have been sent" },
    { label: "unknown EOA confirmation", scenario: { receiptError: new Error("receipt timeout") }, message: "sent but has not confirmed" },
    { label: "reverted receipt", scenario: { receiptStatus: "reverted" }, message: "launch reward could not be claimed" },
  ])("never resends after $label", async ({ scenario, message }) => {
    const { ctx, rpc } = context(scenario);
    const error = await sendLaunchCampaignClaim(ctx, SUMMARY, TICKET).catch((cause: unknown) => cause);
    expect((error as Error).message).toContain(message);
    expect(submissions(rpc)).toHaveLength(1);
    if (scenario.smart) expect(submissions(rpc)[0]![0].method).toBe("wallet_sendCalls");
    if (scenario.receiptError || scenario.receiptStatus) expect(error).toMatchObject({ hash: HASH });
  });
});
