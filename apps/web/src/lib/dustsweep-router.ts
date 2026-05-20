import { encodeFunctionData, type Address, type Hex } from "viem";
import { type DustSweepBuildTxResponse } from "@/types/dustsweep";

import DustSweepRouterABI from "@/abi/DustSweepRouter.json";

export const DUST_SWEEP_ROUTER_ADDRESS = (process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

export const DUST_SWEEP_ROUTER_V2_ADDRESS = (process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_V2_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

export const DUST_SWEEP_EXECUTION_LANE = (process.env.NEXT_PUBLIC_DUST_SWEEP_EXECUTION_LANE ||
  "owned_v1") as "owned_v1" | "owned_v2" | "basket_aggregator";

export const dustSweepRouterAbi = DustSweepRouterABI;
export const V1_MAX_BATCH_SIZE = 10;
export const V2_MAX_BATCH_SIZE = 50;

export const dustSweepRouterV2Abi = [
  {
    name: "sweepWithPermit2",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "target", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "outputToken", type: "address" },
      { name: "receiver", type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "grossAmountOut", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
      { name: "netAmountOut", type: "uint256" },
    ],
  },
] as const;

export function encodeDustSweepPermit2Calldata(_args: {
  routes: unknown[];
  tokenOut: Address;
  receiver: Address;
  deadline: number;
  permit2Nonce: string;
  signature: Hex;
}): Hex {
  throw new Error(
    "encodeDustSweepPermit2Calldata is deprecated. Use V2 backend calldata plus encodeDustSweepV2Calldata.",
  );
}

export function encodeDustSweepV2Calldata(buildTx: DustSweepBuildTxResponse, signature: Hex): Hex {
  if (!buildTx.routes?.length || !buildTx.permit || !buildTx.minAmountOut || !buildTx.witness) {
    throw new Error("V2 sweep transaction is missing route, permit, or witness data");
  }

  return encodeFunctionData({
    abi: dustSweepRouterV2Abi,
    functionName: "sweepWithPermit2",
    args: [
      buildTx.routes.map((route) => ({
        tokenIn: route.tokenIn,
        amountIn: BigInt(route.amountIn),
        target: route.target,
        spender: route.spender,
        value: BigInt(route.value || "0"),
        data: route.data,
      })),
      buildTx.witness.outputToken,
      buildTx.witness.receiver,
      BigInt(buildTx.minAmountOut),
      BigInt(buildTx.permit.deadline),
      {
        permitted: buildTx.permit.permitted.map((item) => ({
          token: item.token,
          amount: BigInt(item.amount),
        })),
        nonce: BigInt(buildTx.permit.nonce),
        deadline: BigInt(buildTx.permit.deadline),
      },
      signature,
    ],
  });
}

export function parseDustSweepError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "");
  const lower = raw.toLowerCase();

  if (lower.includes("deadlineexpired")) return "Deadline expired. Refreshing quote.";
  if (lower.includes("signatureexpired")) return "Deadline expired. Refreshing quote.";
  if (lower.includes("invalidnonce")) return "Permit already used. Refresh quote and try again.";
  if (lower.includes("insufficientoutput")) return "Slippage exceeded, try again or increase slippage.";
  if (lower.includes("batchtoolarge") || lower.includes("toomanytokens")) return "Too many tokens selected for this DustSweep lane.";
  if (lower.includes("zerotokens") || lower.includes("emptyorders")) return "Select at least one token to sweep.";
  if (lower.includes("permitlengthmismatch")) return "Permit data did not match the selected tokens.";
  if (lower.includes("permittokenmismatch") || lower.includes("permitamountmismatch")) return "Permit data did not match the final route.";
  if (lower.includes("targetnotallowed")) return "This route target is not enabled on the V2 router.";
  if (lower.includes("spendernotallowed")) return "This route spender is not enabled on the V2 router.";
  if (lower.includes("nativeinputunsupported")) return "ETH must be wrapped to WETH before sweeping.";
  if (lower.includes("permit2 approval required")) return "Approve Permit2 for the selected tokens and try again.";
  if (lower.includes("router approval required")) return "Approve the DustSweep router for the selected tokens and try again.";
  if (
    lower.includes("atomic batch") ||
    lower.includes("atomicity") ||
    lower.includes("forceatomic") ||
    lower.includes("wallet_sendcalls") ||
    lower.includes("eip-7702")
  ) {
    return "This wallet rejected approval+sweep batching. Use a wallet with EIP-5792/EIP-7702 batch support, or pre-approve the selected tokens with exact caps.";
  }
  if (lower.includes("transfer_from_failed")) return "Permit2 could not pull one token. Refresh balances, approve tokens, and try again.";
  if (lower.includes("transfer amount exceeds balance")) return "One token balance changed. Refresh and try again.";
  if (lower.includes("token balance changed")) return "One token balance changed. Refresh and try again.";
  if (lower.includes("user rejected") || lower.includes("rejected")) return "Transaction cancelled";
  if (lower.includes("route_cap_exceeded")) return "Too many tokens selected for this DustSweep lane.";

  return raw || "Transaction failed";
}
