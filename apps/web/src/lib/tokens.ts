import { type Address } from 'viem';
import { type Token } from '../types/swap';

export const BASE_CHAIN_ID = 8453;
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as Address;
export const WETH_ADDRESS = '0x4200000000000000000000000000000000000006' as Address;
export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
export const CBBTC_ADDRESS = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address;

export const DEFAULT_INPUT_TOKEN: Token = {
  address: NATIVE_ETH,
  symbol: 'ETH',
  name: 'Ethereum',
  decimals: 18,
  logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
};

export const DEFAULT_OUTPUT_TOKEN: Token = {
  address: USDC_ADDRESS,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: 'https://basescan.org/token/images/centre-usdc_28.png',
};

export const DEFAULT_TOKENS: Token[] = [
  DEFAULT_INPUT_TOKEN,
  DEFAULT_OUTPUT_TOKEN,
  {
    address: CBBTC_ADDRESS,
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
    logoURI: 'https://basescan.org/token/images/cbbtc_32.png',
  },
  {
    address: WETH_ADDRESS,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  }
];
