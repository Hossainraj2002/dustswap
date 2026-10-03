import { type Abi, BaseError, ContractFunctionRevertedError, type Hash, type WalletClient } from "viem";

import type { KeeperContext } from "./context";

/** The custom error a call reverted with (e.g. "PricePumped"), or null if it was not a revert. */
export function revertName(error: unknown): string | null {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? "reverted";
  }
  return null;
}

export type CallOutcome<T> =
  | { kind: "sent"; hash: Hash; result: T }
  | { kind: "dry_run"; result: T }
  | { kind: "reverted"; error: string }
  | { kind: "no_wallet" };

/**
 * Simulates first, so a call that would revert costs nothing and says why; then sends and waits
 * for the receipt. In dry-run mode it stops after the simulation.
 */
export async function simulateAndSend<T>(
  ctx: KeeperContext,
  wallet: WalletClient | undefined,
  call: { address: `0x${string}`; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<CallOutcome<T>> {
  if (!wallet?.account) return { kind: "no_wallet" };
  let simulated: { result: unknown; request: unknown };
  try {
    // Simulate in the NEXT block, where the transaction will run. Against "latest", a buyback
    // right after a big buy sees that buy's block and trips the same-block pump guard, which the
    // real transaction (in a later block) would not.
    simulated = (await ctx.client.simulateContract({ ...call, account: wallet.account, blockTag: "pending" } as never)) as { result: unknown; request: unknown };
  } catch (error) {
    const name = revertName(error);
    if (name) return { kind: "reverted", error: name };
    throw error;
  }
  if (ctx.dryRun) return { kind: "dry_run", result: simulated.result as T };
  const hash = await wallet.writeContract(simulated.request as never);
  const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") return { kind: "reverted", error: `transaction ${hash} reverted` };
  return { kind: "sent", hash, result: simulated.result as T };
}
