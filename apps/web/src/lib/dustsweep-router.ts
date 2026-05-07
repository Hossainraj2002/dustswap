import {
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { WETH_ADDRESS } from "@/lib/tokens";
import { type DustSweepRoute } from "@/types/dustsweep";

export const DUST_SWEEP_ROUTER_ADDRESS = (process.env
  .NEXT_PUBLIC_DUST_SWEEP_ROUTER ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

export const dustSweepRouterAbi = [
  {
    name: "sweepDust",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "minAmountOut", type: "uint256" },
        ],
      },
      { name: "tokenOut", type: "address" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "sweepDustToETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "minAmountOut", type: "uint256" },
        ],
      },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "sweepDustMultiHop",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "path", type: "bytes" },
          { name: "minAmountOut", type: "uint256" },
        ],
      },
      { name: "tokenOut", type: "address" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export function encodeDustSweepCalldata(args: {
  routes: DustSweepRoute[];
  tokenOut: Address;
  receiver: Address;
  deadline: number;
}): Hex {
  const orders = args.routes.map((route) => ({
    tokenIn: route.tokenIn,
    amountIn: BigInt(route.amountIn),
    poolFee: route.poolFee ?? 3000,
    minAmountOut: BigInt(route.amountOutMin),
  }));

  if (args.tokenOut.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    return encodeFunctionData({
      abi: dustSweepRouterAbi,
      functionName: "sweepDust",
      args: [orders, args.tokenOut, args.receiver, BigInt(args.deadline)],
    });
  }

  return encodeFunctionData({
    abi: dustSweepRouterAbi,
    functionName: "sweepDust",
    args: [orders, args.tokenOut, args.receiver, BigInt(args.deadline)],
  });
}

export function parseDustSweepError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "");
  const lower = raw.toLowerCase();

  if (lower.includes("deadlineexpired")) return "Deadline expired. Refreshing quote.";
  if (lower.includes("insufficientoutput")) return "Slippage exceeded, try again or increase slippage.";
  if (lower.includes("batchtoolarge")) return "DustSweep can sweep up to 50 tokens in one batch.";
  if (lower.includes("emptyorders")) return "Select at least one token to sweep.";
  if (lower.includes("transfer amount exceeds balance")) return "One token balance changed. Refresh and try again.";
  if (lower.includes("user rejected") || lower.includes("rejected")) return "Transaction cancelled";

  return raw || "Transaction failed";
}
