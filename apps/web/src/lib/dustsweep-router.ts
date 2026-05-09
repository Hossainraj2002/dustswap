import { encodeFunctionData, type Address, type Hex } from "viem";
import { type DustSweepRoute } from "@/types/dustsweep";

export const DUST_SWEEP_ROUTER_ADDRESS = (process.env
  .NEXT_PUBLIC_DUST_SWEEP_ROUTER ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

export const dustSweepRouterAbi = [
  {
    name: "sweep",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "routes",
            type: "tuple[]",
            components: [
              { name: "tokenIn", type: "address" },
              { name: "amountIn", type: "uint256" },
              { name: "amountOutMin", type: "uint256" },
              { name: "dex", type: "uint8" },
              { name: "dexData", type: "bytes" },
            ],
          },
          { name: "tokenOut", type: "address" },
          { name: "receiver", type: "address" },
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
      },
    ],
    outputs: [{ name: "netOut", type: "uint256" }],
  },
] as const;

export function encodeDustSweepPermit2Calldata(args: {
  routes: DustSweepRoute[];
  tokenOut: Address;
  receiver: Address;
  deadline: number;
  permit2Nonce: string;
  signature: Hex;
}): Hex {
  return encodeFunctionData({
    abi: dustSweepRouterAbi,
    functionName: "sweep",
    args: [
      {
        routes: args.routes.map((route) => ({
          tokenIn: route.tokenIn,
          amountIn: BigInt(route.amountIn),
          amountOutMin: BigInt(route.amountOutMin),
          dex: route.dex,
          dexData: route.dexData,
        })),
        tokenOut: args.tokenOut,
        receiver: args.receiver,
        deadline: BigInt(args.deadline),
        permit: {
          permitted: args.routes.map((route) => ({
            token: route.tokenIn,
            amount: BigInt(route.amountIn),
          })),
          nonce: BigInt(args.permit2Nonce),
          deadline: BigInt(args.deadline),
        },
        signature: args.signature,
      },
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
  if (lower.includes("toomanytokens")) return "DustSweep can sweep up to 50 tokens in one batch.";
  if (lower.includes("zerotokens")) return "Select at least one token to sweep.";
  if (lower.includes("permitlengthmismatch")) return "Permit data did not match the selected tokens.";
  if (lower.includes("permit2 approval required")) return "Approve the selected tokens and try again.";
  if (lower.includes("transfer_from_failed")) return "Permit2 could not pull one token. Refresh balances, approve tokens, and try again.";
  if (lower.includes("transfer amount exceeds balance")) return "One token balance changed. Refresh and try again.";
  if (lower.includes("token balance changed")) return "One token balance changed. Refresh and try again.";
  if (lower.includes("user rejected") || lower.includes("rejected")) return "Transaction cancelled";

  return raw || "Transaction failed";
}
