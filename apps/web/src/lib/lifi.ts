"use client";

import { EVM } from "@lifi/sdk";
import { getConnectorClient, switchChain } from "wagmi/actions";
import {
  appendBuilderCodeToData,
  DATA_SUFFIX,
} from "@/lib/builderCode";
import { wagmiConfig } from "@/wagmi";

async function getBuilderCodeWalletClient(chainId?: number) {
  const client = await getConnectorClient(wagmiConfig as any, {
    assertChainId: false,
    ...(chainId ? { chainId } : {}),
  } as any);

  const request = client.request.bind(client);

  // Keep Wagmi's native connector client intact and enforce builder-code
  // attribution at the final JSON-RPC payload LI.FI sends to the wallet.
  return Object.assign(client, {
    dataSuffix: DATA_SUFFIX,
    request: async (args: any, options?: any) => {
      if (
        args?.method === "eth_sendTransaction" ||
        args?.method === "wallet_sendTransaction"
      ) {
        const [transaction, ...rest] = args.params ?? [];

        return request(
          {
            ...args,
            params: [
              {
                ...transaction,
                data: appendBuilderCodeToData(transaction?.data),
              },
              ...rest,
            ],
          },
          options
        );
      }

      if (args?.method === "wallet_sendCalls") {
        const [payload, ...rest] = args.params ?? [];

        return request(
          {
            ...args,
            params: [
              {
                ...payload,
                capabilities: {
                  ...payload?.capabilities,
                  dataSuffix: {
                    value: DATA_SUFFIX,
                  },
                },
              },
              ...rest,
            ],
          },
          options
        );
      }

      return request(args, options);
    },
  });
}

export const lifiEvmProvider = EVM({
  getWalletClient: async () => getBuilderCodeWalletClient(),
  switchChain: async (chainId) => {
    const chain = await switchChain(wagmiConfig as any, { chainId } as any);
    return getBuilderCodeWalletClient(chain.id);
  },
});
