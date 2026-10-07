import { createWalletClient, custom, type WalletClient } from "viem";
import { BUILDER_ATTRIBUTION } from "./builderCode";

/**
 * The connected provider stays in charge of accounts, signing and submission. Viem adds
 * attribution to transactions and requires the dataSuffix capability for EIP-5792 batches.
 * Signing messages/typed data has no calldata and remains unchanged.
 */
export function withBuilderAttribution(wallet: WalletClient, options: { requiresWalletAttribution?: boolean } = {}) {
  return createWalletClient({
    account: wallet.account,
    chain: wallet.chain,
    transport: custom({ request: wallet.request }, { retryCount: 0 }),
    dataSuffix: BUILDER_ATTRIBUTION,
  }).extend(() => ({ requiresWalletAttribution: options.requiresWalletAttribution === true }));
}
