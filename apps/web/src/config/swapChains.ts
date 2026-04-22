export type SupportedSwapChain = {
  id: number;
  key: string;
  label: string;
};

export const SUPPORTED_SWAP_CHAINS = [
  { id: 8453, key: "base", label: "Base" },
  { id: 1, key: "ethereum", label: "Ethereum" },
  { id: 42161, key: "arbitrum", label: "Arbitrum" },
  { id: 10, key: "optimism", label: "Optimism" },
  { id: 137, key: "polygon", label: "Polygon" },
  { id: 56, key: "bsc", label: "BNB Chain" },
  { id: 43114, key: "avalanche", label: "Avalanche" },
  { id: 324, key: "zksync", label: "zkSync Era" },
  { id: 250, key: "fantom", label: "Fantom" },
  { id: 146, key: "sonic", label: "Sonic" },
  { id: 80094, key: "berachain", label: "Berachain" },
  { id: 59144, key: "linea", label: "Linea" },
  { id: 999, key: "hyperevm", label: "HyperEVM" },
  { id: 9745, key: "plasma", label: "Plasma" },
  { id: 143, key: "monad", label: "Monad" },
  { id: 1776, key: "injective", label: "Injective" },
  { id: 534352, key: "scroll", label: "Scroll" },
  { id: 81457, key: "blast", label: "Blast" },
  { id: 34443, key: "mode", label: "Mode" },
  { id: 5000, key: "mantle", label: "Mantle" },
  { id: 130, key: "unichain", label: "Unichain" },
  { id: 100, key: "gnosis", label: "Gnosis" },
  { id: 42220, key: "celo", label: "Celo" },
  { id: 1088, key: "metis", label: "Metis" },
  { id: 1101, key: "polygon-zkevm", label: "Polygon zkEVM" },
  { id: 2222, key: "kava", label: "Kava" },
  { id: 204, key: "opbnb", label: "opBNB" },
  { id: 25, key: "cronos", label: "Cronos" },
  { id: 1313161554, key: "aurora", label: "Aurora" },
  { id: 1285, key: "moonriver", label: "Moonriver" },
  { id: 1666600000, key: "harmony", label: "Harmony" },
  { id: 1329, key: "sei", label: "Sei" },
  { id: 33139, key: "apechain", label: "ApeChain" },
  { id: 14, key: "flare", label: "Flare" },
  { id: 30, key: "rootstock", label: "Rootstock" },
  { id: 1625, key: "gravity", label: "Gravity" },
  { id: 1923, key: "swell", label: "Swell" },
  { id: 98866, key: "plume", label: "Plume" },
  { id: 239, key: "tac", label: "TAC" },
  { id: 40, key: "telos", label: "Telos" },
  { id: 169, key: "manta", label: "Manta Pacific" },
] as const satisfies readonly SupportedSwapChain[];

export const SUPPORTED_SWAP_CHAIN_IDS = SUPPORTED_SWAP_CHAINS.map(
  (chain) => chain.id
);

export const OPENOCEAN_WIDGET_CHAIN_IDS = SUPPORTED_SWAP_CHAIN_IDS;

const supportedSwapChainIds = new Set<number>(SUPPORTED_SWAP_CHAIN_IDS);

export function isSupportedSwapChainId(chainId: number) {
  return supportedSwapChainIds.has(chainId);
}

export function getSwapChainLabel(chainId: number) {
  return (
    SUPPORTED_SWAP_CHAINS.find((chain) => chain.id === chainId)?.label ||
    `Chain ${chainId}`
  );
}
