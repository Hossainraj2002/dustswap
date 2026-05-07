import { concatHex, type Address, type Hex } from "viem";
import { BASE_CHAIN_ID } from "@/lib/tokens";
import {
  type DustSweepRoute,
  type Permit2TypedData,
} from "@/types/dustsweep";

export const PERMIT2_ADDRESS = (process.env.NEXT_PUBLIC_PERMIT2_ADDRESS ||
  "0x000000000022D473030F116dDEE9F6B43aC78BA3") as Address;

export const permit2BatchTransferTypes = {
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  PermitBatchTransferFrom: [
    { name: "permitted", type: "TokenPermissions[]" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function buildPermit2TypedData(args: {
  routes: DustSweepRoute[];
  spender: Address;
  nonce: string;
  deadline: number | string;
}): Permit2TypedData {
  return {
    domain: {
      name: "Permit2",
      chainId: BASE_CHAIN_ID,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: permit2BatchTransferTypes,
    message: {
      permitted: args.routes.map((route) => ({
        token: route.tokenIn,
        amount: route.amountIn,
      })),
      spender: args.spender,
      nonce: String(args.nonce),
      deadline: String(args.deadline),
    },
  };
}

export function appendSignatureToCalldata(calldata: Hex, signature: Hex): Hex {
  if (!signature || signature === "0x") {
    return calldata;
  }

  return concatHex([calldata, signature]);
}

export function getPermit2SignatureErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error || "Signature failed");
  const lowered = message.toLowerCase();

  if (
    lowered.includes("user rejected") ||
    lowered.includes("rejected") ||
    lowered.includes("denied") ||
    lowered.includes("cancel")
  ) {
    return "Signature cancelled";
  }

  return message;
}
