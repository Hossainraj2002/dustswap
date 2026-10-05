import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";

import { coinTransferAbi } from "./lib/abi-extra";
import { chainSettings } from "./lib/chain";
import { loadDeployment } from "./lib/deployment";
import {
  buybackBurnVaultAbi,
  feeVaultAbi,
  floorVaultAbi,
  holderRewardDistributorAbi,
  memeFunConfigAbi,
  memeFunFactoryAbi,
  memeFunHookAbi,
} from "./shared/abis";

/**
 * One chain per deployment, chosen by MEMEFUN_CHAIN (local | base-sepolia | base); contract
 * addresses and the start block come from deployments/<chainId>.json. The chain is always called
 * "memefun" here so the indexing code is the same on every network.
 */
const chain = chainSettings();
const deployment = loadDeployment(chain.id);
const startBlock = deployment.deployedAtBlock;

export default createConfig({
  database: {
    kind: "postgres",
    connectionString: process.env.DATABASE_URL,
    poolConfig: { max: 20 },
  },
  chains: {
    memefun: {
      id: chain.id,
      rpc: chain.rpcUrls,
      pollingInterval: chain.pollingIntervalMs,
      // A local chain is rebuilt from scratch on every `pnpm dev:chain`: never reuse cached RPC data.
      disableCache: chain.key === "local",
    },
  },
  contracts: {
    MemeFunConfig: { chain: "memefun", abi: memeFunConfigAbi, address: deployment.config, startBlock },
    MemeFunFactory: { chain: "memefun", abi: memeFunFactoryAbi, address: deployment.factory, startBlock },
    MemeFunHook: { chain: "memefun", abi: memeFunHookAbi, address: deployment.hook, startBlock },
    FeeVault: { chain: "memefun", abi: feeVaultAbi, address: deployment.feeVault, startBlock },
    BuybackBurnVault: { chain: "memefun", abi: buybackBurnVaultAbi, address: deployment.buybackBurnVault, startBlock },
    FloorVault: { chain: "memefun", abi: floorVaultAbi, address: deployment.floorVault, startBlock },
    HolderRewardDistributor: {
      chain: "memefun",
      abi: holderRewardDistributorAbi,
      address: deployment.holderRewardDistributor,
      startBlock,
    },
    // Every coin the factory launches, discovered from `Launched`. Logs from earlier in the
    // launch block (the mint, the first buy's transfers) are included.
    Coin: {
      chain: "memefun",
      abi: coinTransferAbi,
      address: factory({
        address: deployment.factory,
        event: getAbiItem({ abi: memeFunFactoryAbi, name: "Launched" }),
        parameter: "coin",
      }),
      startBlock,
    },
  },
  blocks: {
    // Samples all registered Chainlink quotes (ETH and stock feeds), retaining feed timestamps.
    EthUsdPrice: { chain: "memefun", interval: chain.priceIntervalBlocks, startBlock },
  },
});
