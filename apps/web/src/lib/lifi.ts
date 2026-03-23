"use client";

import { EVM } from "@lifi/sdk";
import { getConnectorClient, switchChain } from "wagmi/actions";
import { DATA_SUFFIX } from "@/lib/builderCode";
import { wagmiConfig } from "@/wagmi";

async function getBuilderCodeWalletClient(chainId?: number) {
  const client = await getConnectorClient(wagmiConfig as any, {
    assertChainId: false,
    ...(chainId ? { chainId } : {}),
  } as any);

  // Keep Wagmi's native connector client intact for LI.FI execution and only
  // attach Base's attribution suffix so sendTransaction/sendCalls include it.
  return Object.assign(client, {
    dataSuffix: DATA_SUFFIX,
  });
}

export const lifiEvmProvider = EVM({
  getWalletClient: async () => getBuilderCodeWalletClient(),
  switchChain: async (chainId) => {
    const chain = await switchChain(wagmiConfig as any, { chainId } as any);
    return getBuilderCodeWalletClient(chain.id);
  },
});
