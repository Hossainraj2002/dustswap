"use client";

import { EVM } from "@lifi/sdk";
import { createWalletClient, custom } from "viem";
import { getAddress, parseAccount } from "viem/utils";
import { switchChain } from "wagmi/actions";
import { DATA_SUFFIX } from "@/lib/builderCode";
import { wagmiConfig } from "@/wagmi";

function getActiveConnection() {
  const currentConnectionId = wagmiConfig.state.current;

  if (!currentConnectionId) {
    throw new Error("No connected wallet found for LI.FI execution.");
  }

  const connection = wagmiConfig.state.connections.get(currentConnectionId);

  if (!connection) {
    throw new Error("No connected wallet found for LI.FI execution.");
  }

  return connection;
}

async function getBuilderCodeWalletClient(chainId?: number) {
  const connection = getActiveConnection();
  const targetChainId = chainId ?? connection.chainId;
  const connectedAccount = connection.accounts[0];

  if (!connectedAccount) {
    throw new Error("No connected account found for LI.FI execution.");
  }

  const configuredChains = (
    wagmiConfig._internal.chains as unknown as { getState(): typeof wagmiConfig.chains }
  ).getState();
  const chain = configuredChains.find(
    (configuredChain) => configuredChain.id === targetChainId
  );

  if (!chain) {
    throw new Error(`Wagmi chain ${targetChainId} is not configured.`);
  }

  const account = parseAccount(connectedAccount);
  account.address = getAddress(account.address);

  const provider = await connection.connector.getProvider({
    chainId: targetChainId,
  });

  return createWalletClient({
    account,
    chain,
    dataSuffix: DATA_SUFFIX,
    key: "dustswap-lifi-wallet-client",
    name: "DustSwap LI.FI Wallet Client",
    transport: custom(provider as any, { retryCount: 0 }),
  });
}

export const lifiEvmProvider = EVM({
  getWalletClient: async () => getBuilderCodeWalletClient(),
  switchChain: async (chainId) => {
    const chain = await switchChain(wagmiConfig as any, { chainId } as any);
    return getBuilderCodeWalletClient(chain.id);
  },
});
