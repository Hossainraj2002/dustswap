import { http, createConfig } from "wagmi";
import { coinbaseWallet } from "wagmi/connectors";
import { getRpcUrlForChain, SUPPORTED_EVM_CHAINS } from "@/config/web3";

// @ts-ignore - ox exports may not resolve correctly in Next.js bundler types
import { Attribution } from "ox/erc8021";

const DATA_SUFFIX = Attribution.toDataSuffix({
  codes: [process.env.NEXT_PUBLIC_BUILDER_CODE || "bc_ox7237gv"],
});

export const wagmiConfig = createConfig({
  chains: [...SUPPORTED_EVM_CHAINS] as any,
  connectors: [
    coinbaseWallet({
      appName: "DustSwap",
      appLogoUrl: "https://dustswap.xyz/logo.png",
      preference: "smartWalletOnly",
    }),
  ],
  transports: {
    ...Object.fromEntries(
      SUPPORTED_EVM_CHAINS.map((chain) => [
        chain.id,
        http(getRpcUrlForChain(chain.id)),
      ])
    ),
  },
  dataSuffix: DATA_SUFFIX,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
