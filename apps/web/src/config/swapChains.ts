export type SupportedSwapChain = {
  id: number;
  key: string;
  label: string;
};

// Capture-supported EVM chains only. The OpenOcean widget intentionally uses
// its own default chain list and is not restricted by this config.
export const SUPPORTED_SWAP_CHAINS = [
  { id: 8453, key: "base", label: "Base" },
  { id: 1, key: "ethereum", label: "Ethereum" },
  { id: 42161, key: "arbitrum", label: "Arbitrum" },
  { id: 10, key: "optimism", label: "Optimism" },
  { id: 137, key: "polygon", label: "Polygon" },
  { id: 56, key: "bsc", label: "BNB Chain" },
  { id: 43114, key: "avalanche", label: "Avalanche" },
  { id: 324, key: "zksync", label: "zkSync Era" },
  { id: 59144, key: "linea", label: "Linea" },
  { id: 534352, key: "scroll", label: "Scroll" },
] as const satisfies readonly SupportedSwapChain[];

export const SUPPORTED_SWAP_CAPTURE_CHAIN_IDS = SUPPORTED_SWAP_CHAINS.map(
  (chain) => chain.id
);

export const SUPPORTED_SWAP_CHAIN_IDS = SUPPORTED_SWAP_CAPTURE_CHAIN_IDS;

const supportedSwapCaptureChainIds = new Set<number>(
  SUPPORTED_SWAP_CAPTURE_CHAIN_IDS
);

export function isSupportedSwapCaptureChainId(chainId: number) {
  return supportedSwapCaptureChainIds.has(chainId);
}

export function isSupportedSwapChainId(chainId: number) {
  return isSupportedSwapCaptureChainId(chainId);
}

export function getSwapChainLabel(chainId: number) {
  return (
    SUPPORTED_SWAP_CHAINS.find((chain) => chain.id === chainId)?.label ||
    `Chain ${chainId}`
  );
}
