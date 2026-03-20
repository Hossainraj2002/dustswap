"use client";

import { ChainType, config as lifiConfig, getChains } from "@lifi/sdk";
import { useSyncWagmiConfig } from "@lifi/wallet-management";
import { useQuery } from "@tanstack/react-query";
import { wagmiConfig, wagmiConnectors } from "@/wagmi";

export function LifiEvmChainSync() {
  const { data: chains } = useQuery({
    queryKey: ["lifi", "chains", "evm"],
    queryFn: async () => {
      const evmChains = await getChains({
        chainTypes: [ChainType.EVM],
      });

      lifiConfig.setChains(evmChains);
      return evmChains;
    },
    staleTime: 6 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useSyncWagmiConfig(wagmiConfig, wagmiConnectors, chains);

  return null;
}
