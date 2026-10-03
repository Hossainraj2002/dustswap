"use client";

import type { Address } from "viem";
import { getConnection, getWalletClient, switchChain } from "wagmi/actions";
import { CHAIN_NAME, TARGET_CHAIN_ID } from "@/lib/chain";
import { TxError } from "@/lib/market/Market";
import { wagmiConfig } from "@/lib/wallet/wagmi";
import type { TxWallet } from "./tx";
import { toTxError } from "./txErrors";

export { DATA_SUFFIX } from "@/lib/wallet/builderCode";

/**
 * The connected wallet as a viem wallet client. Loaded on demand (the first trade, launch,
 * claim or sign-in), so the wallet stack never weighs on the first page load. It shares the
 * wagmi config PrivyHost connects through.
 *
 * `onChain` (the default) switches the wallet to memefun's chain first, as every transaction
 * needs; signing a message does not.
 */
export async function connectedWallet(expected?: Address, options: { onChain?: boolean } = {}): Promise<TxWallet> {
  const connection = getConnection(wagmiConfig);
  if (!connection.address || connection.status !== "connected") throw new TxError("Connect your wallet first.", "reverted");
  if (expected && connection.address.toLowerCase() !== expected.toLowerCase()) {
    throw new TxError("Your wallet switched accounts. Check the connected account and try again.", "reverted");
  }
  const onChain = options.onChain ?? true;
  if (onChain && connection.chainId !== TARGET_CHAIN_ID) {
    try {
      await switchChain(wagmiConfig, { chainId: TARGET_CHAIN_ID });
    } catch (error) {
      throw toTxError(error, `Switch your wallet to ${CHAIN_NAME} and try again.`);
    }
  }
  try {
    const client = await getWalletClient(wagmiConfig, onChain ? { chainId: TARGET_CHAIN_ID, account: connection.address } : { account: connection.address });
    return client as unknown as TxWallet;
  } catch (error) {
    throw toTxError(error, "Your wallet is not ready. Reconnect it and try again.");
  }
}
