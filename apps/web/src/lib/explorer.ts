import { getSweepChain } from "@/config/sweepChainConfig";

/**
 * Block-explorer tx URL for a sweep chain. Base → basescan.org, Ethereum → etherscan.io.
 * Defaults to Base when the chain is unknown so existing callers are unaffected.
 */
export function getExplorerTxUrl(chainId: number | undefined, txHash: string): string {
  const chain = getSweepChain(chainId ?? 8453);
  return `${chain.explorerUrl}/tx/${txHash}`;
}
