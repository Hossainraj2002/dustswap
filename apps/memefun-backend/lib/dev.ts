import {
  type Account,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  publicActions,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { localChain } from "./chain";

/**
 * Local development only: anvil's public test mnemonic and the roles DevDeploy gives its
 * accounts. These keys hold nothing anywhere but a local chain.
 */
export const DEV_MNEMONIC = "test test test test test test test test test test test junk";

export const DEV_ROLES = {
  deployer: 0,
  alice: 1,
  bob: 2,
  carol: 3,
  dave: 4,
  erin: 5,
  frank: 6,
  treasury: 7,
  priceKeeper: 8,
  publisher: 9,
} as const;

export type DevRole = keyof typeof DEV_ROLES;

export function devAccount(role: DevRole): Account & { address: Address } {
  return mnemonicToAccount(DEV_MNEMONIC, { addressIndex: DEV_ROLES[role] });
}

export const LOCAL_RPC_URL = "http://127.0.0.1:8545";

export function localClients(rpcUrl = LOCAL_RPC_URL) {
  const transport = http(rpcUrl);
  return {
    publicClient: createPublicClient({ chain: localChain, transport }),
    testClient: createTestClient({ chain: localChain, transport, mode: "anvil" }).extend(publicActions),
    wallet: (role: DevRole) => createWalletClient({ chain: localChain, transport, account: devAccount(role) }),
  };
}
