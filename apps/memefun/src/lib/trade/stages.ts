import type { TxStage } from "@/lib/market/Market";

/**
 * The busy button's label for each step of a live action, so people always know whether the
 * wallet is waiting for them or the network is working.
 */
export function stageLabel(stage: TxStage | null, options: { token?: string; chainName: string; pending?: string }): string {
  switch (stage) {
    case "upload":
      return "Saving the image and details";
    case "approve":
      return options.token ? `Approve ${options.token} in your wallet` : "Approve in your wallet";
    case "sign":
      return "Sign in your wallet";
    case "pending":
      return options.pending ?? `Confirming on ${options.chainName}`;
    case "confirm":
    default:
      return "Confirm in your wallet";
  }
}
