import { LOCAL_CHAIN_ID, TARGET_CHAIN_ID } from "@/lib/chain";
import { DEPLOYMENTS, type MemefunDeployment } from "@/lib/contracts/deployments";

/** The memefun backend (apps/memefun-backend), e.g. https://memefun-api.up.railway.app. */
export const API_URL = (process.env.NEXT_PUBLIC_MEMEFUN_API_URL ?? "").trim().replace(/\/+$/, "");

/** This build's own contract addresses for its chain. Null on the local chain. */
export const BUILT_DEPLOYMENT: MemefunDeployment | null = DEPLOYMENTS[TARGET_CHAIN_ID] ?? null;

/**
 * Live mode needs an API and, on a public chain, addresses compiled into the build. A local
 * development chain takes its addresses from the local API instead.
 */
export function liveConfigured(): boolean {
  return API_URL !== "" && (BUILT_DEPLOYMENT !== null || TARGET_CHAIN_ID === LOCAL_CHAIN_ID);
}

const CHECKED_KEYS = ["config", "factory", "router", "hook", "feeVault", "holderRewardDistributor", "poolManager"] as const;

/**
 * The deployment to transact with: the build's own, after checking the API indexes the same
 * contracts. A mismatch means the app and its server disagree, so nothing may be sent.
 */
export function resolveDeployment(api: MemefunDeployment | null): MemefunDeployment {
  if (BUILT_DEPLOYMENT) {
    if (api) {
      if (api.chainId !== BUILT_DEPLOYMENT.chainId) throw new DeploymentMismatch(`chain ${api.chainId}`);
      for (const key of CHECKED_KEYS) {
        if (api[key]?.toLowerCase() !== BUILT_DEPLOYMENT[key].toLowerCase()) throw new DeploymentMismatch(key);
      }
    }
    return BUILT_DEPLOYMENT;
  }
  if (TARGET_CHAIN_ID === LOCAL_CHAIN_ID && api && api.chainId === LOCAL_CHAIN_ID) return api;
  throw new DeploymentMismatch("no deployment for this chain");
}

export class DeploymentMismatch extends Error {
  constructor(readonly detail: string) {
    super(`The app and its server disagree about the memefun contracts (${detail}).`);
    this.name = "DeploymentMismatch";
  }
}
