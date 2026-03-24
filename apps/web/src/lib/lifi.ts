"use client";

import { EVM } from "@lifi/sdk";
import { getConnectorClient, switchChain } from "wagmi/actions";
import { appendBuilderCodeToData, DATA_SUFFIX } from "@/lib/builderCode";
import { wagmiConfig } from "@/wagmi";

async function getBuilderCodeWalletClient(chainId?: number) {
  const client = await getConnectorClient(wagmiConfig as any, {
    assertChainId: false,
    ...(chainId ? { chainId } : {}),
  } as any);

  const request = client.request.bind(client);

  // Keep Wagmi's native connector client intact, but make LI.FI prefer the
  // standard sendTransaction path so ERC-8021 attribution lands on calldata.
  return Object.assign(client, {
    request: async (args: any, options?: any) => {
      if (args?.method === "wallet_getCapabilities") {
        const capabilities = await request(args, options);

        if (!capabilities || typeof capabilities !== "object") {
          return capabilities;
        }

        return Object.fromEntries(
          Object.entries(capabilities).map(([key, value]) => {
            if (!value || typeof value !== "object") {
              return [key, value];
            }

            return [
              key,
              {
                ...(value as Record<string, unknown>),
                atomic: {
                  status: "unsupported",
                },
                atomicBatch: {
                  supported: false,
                },
              },
            ];
          })
        );
      }

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
                calls: (payload?.calls ?? []).map((call: any) => ({
                  ...call,
                  data: appendBuilderCodeToData(call?.data),
                })),
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
