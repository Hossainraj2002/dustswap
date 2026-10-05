import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";

/** The record `script/Deploy.s.sol` (or `DevDeploy.s.sol`) writes for each chain. */
export interface Deployment {
  chainId: number;
  deployedAtBlock: number;
  poolManager: Address;
  config: Address;
  feeVault: Address;
  factory: Address;
  router: Address;
  hook: Address;
  buybackBurnVault: Address;
  floorVault: Address;
  holderRewardDistributor: Address;
  ethUsdFeed: Address;
  usdc: Address;
  owner: Address;
  treasury: Address;
  priceKeeper: Address;
  rewardsPublisher: Address;
  tweetAttestor?: Address;
  /** Local chain and testnets only: the test stock and the faucet that mints it. */
  stock?: Address;
  stockFaucet?: Address;
}

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "not an address")
  .transform((value) => getAddress(value));

const schema = z.object({
  chainId: z.number().int().positive(),
  deployedAtBlock: z.number().int().nonnegative(),
  poolManager: address,
  config: address,
  feeVault: address,
  factory: address,
  router: address,
  hook: address,
  buybackBurnVault: address,
  floorVault: address,
  holderRewardDistributor: address,
  ethUsdFeed: address,
  usdc: address,
  owner: address,
  treasury: address,
  priceKeeper: address,
  rewardsPublisher: address,
  tweetAttestor: address.optional(),
  stock: address.optional(),
  stockFaucet: address.optional(),
});

const deploymentsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../deployments");

export function parseDeployment(json: unknown, expectedChainId?: number): Deployment {
  const parsed = schema.parse(json);
  if (expectedChainId !== undefined && parsed.chainId !== expectedChainId) {
    throw new Error(`Deployment record is for chain ${parsed.chainId}, expected ${expectedChainId}.`);
  }
  return parsed;
}

/**
 * Loads `deployments/<chainId>.json` (synced from packages/memefun-contracts by
 * `pnpm sync-shared`, or written there by `pnpm dev:chain`).
 */
export function loadDeployment(chainId: number, dir = deploymentsDir): Deployment {
  const path = resolve(dir, `${chainId}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      chainId === 31337
        ? `No local deployment at ${path}. Run \`pnpm dev:chain\` first.`
        : `No deployment record at ${path}. Deploy with script/Deploy.s.sol, then run \`pnpm sync-shared\`.`,
    );
  }
  return parseDeployment(JSON.parse(raw), chainId);
}

/** Every memefun contract: never a holder, never paid holder rewards. */
export function protocolAddresses(d: Deployment): Address[] {
  return [
    d.poolManager,
    d.config,
    d.feeVault,
    d.factory,
    d.router,
    d.hook,
    d.buybackBurnVault,
    d.floorVault,
    d.holderRewardDistributor,
  ];
}
