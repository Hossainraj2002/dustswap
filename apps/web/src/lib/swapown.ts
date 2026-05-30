import { type Address } from "viem";
import { arbitrum, avalanche, base, bsc, mainnet, polygon, type Chain } from "wagmi/chains";

export type SwapOwnToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
};

export type SwapOwnChain = {
  id: number;
  key: string;
  label: string;
  chain: Chain;
  tokens: SwapOwnToken[];
};

const ETH_LOGO = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png";
const USDC_LOGO =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png";

export const SWAPOWN_CHAINS: SwapOwnChain[] = [
  {
    id: base.id,
    key: "base",
    label: "Base",
    chain: base,
    tokens: [
      {
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: 18,
        logoURI: ETH_LOGO,
      },
      {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        logoURI: USDC_LOGO,
      },
    ],
  },
  {
    id: mainnet.id,
    key: "ethereum",
    label: "Ethereum",
    chain: mainnet,
    tokens: [
      {
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: 18,
        logoURI: ETH_LOGO,
      },
      {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        logoURI: USDC_LOGO,
      },
    ],
  },
  {
    id: bsc.id,
    key: "bsc",
    label: "BNB Chain",
    chain: bsc,
    tokens: [
      {
        address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        symbol: "WBNB",
        name: "Wrapped BNB",
        decimals: 18,
      },
      {
        address: "0x55d398326f99059fF775485246999027B3197955",
        symbol: "USDT",
        name: "Tether USD",
        decimals: 18,
      },
    ],
  },
  {
    id: polygon.id,
    key: "polygon",
    label: "Polygon",
    chain: polygon,
    tokens: [
      {
        address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        symbol: "WMATIC",
        name: "Wrapped MATIC",
        decimals: 18,
      },
      {
        address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        symbol: "USDC.e",
        name: "USD Coin bridged",
        decimals: 6,
        logoURI: USDC_LOGO,
      },
    ],
  },
  {
    id: arbitrum.id,
    key: "arbitrum",
    label: "Arbitrum",
    chain: arbitrum,
    tokens: [
      {
        address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: 18,
        logoURI: ETH_LOGO,
      },
      {
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        logoURI: USDC_LOGO,
      },
    ],
  },
  {
    id: avalanche.id,
    key: "avalanche",
    label: "Avalanche",
    chain: avalanche,
    tokens: [
      {
        address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
        symbol: "WAVAX",
        name: "Wrapped AVAX",
        decimals: 18,
      },
      {
        address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        logoURI: USDC_LOGO,
      },
    ],
  },
];

export function getSwapOwnChain(chainId: number) {
  return SWAPOWN_CHAINS.find((chain) => chain.id === chainId) || SWAPOWN_CHAINS[0];
}

export function getSwapOwnToken(chainId: number, address: string) {
  const normalized = address.toLowerCase();
  return getSwapOwnChain(chainId).tokens.find((token) => token.address.toLowerCase() === normalized);
}

export function shortHash(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function explorerTxUrl(chainId: number, txHash: string) {
  const chain = getSwapOwnChain(chainId).chain;
  const baseUrl = chain.blockExplorers?.default.url;
  return baseUrl ? `${baseUrl}/tx/${txHash}` : "";
}
