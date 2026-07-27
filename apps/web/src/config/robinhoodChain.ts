import { defineChain } from "viem";
import type { Chain } from "wagmi/chains";

/**
 * Robinhood Chain (chainId 4663) — wagmi/viem ship no definition for it (checked viem 2.52), so
 * it is defined locally. Arbitrum-stack L2 whose native gas token IS ETH (the wrapped native is
 * literally WETH — no WBNB-style rename anywhere). Verified live 2026-07-26: eth_chainId=0x1237
 * on the public RPC below.
 *
 * NEXT_PUBLIC bundle rule: this default RPC is the PUBLIC rate-limited endpoint. Paid Alchemy
 * keys stay server-side (ALCHEMY_ROBINHOOD_RPC_KEYS on Railway) — never NEXT_PUBLIC_*.
 */
export const robinhood: Chain = defineChain({
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});
