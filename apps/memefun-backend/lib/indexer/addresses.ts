import { type Address, getAddress, zeroAddress } from "viem";

import { DEAD_ADDRESS } from "../../shared/core/constants";
import { type Deployment, protocolAddresses } from "../deployment";

export type Lower = `0x${string}`;

/** Addresses are compared and stored lowercase everywhere in the indexer (Ponder's hex columns are). */
export function lc(address: string): Lower {
  return address.toLowerCase() as Lower;
}

export const ZERO = lc(zeroAddress);
export const DEAD = lc(DEAD_ADDRESS);

/** Uniswap's Universal Router per chain: trades through it are attributed to the transaction sender. */
const UNIVERSAL_ROUTERS: Record<number, Address[]> = {
  8453: ["0x6fF5693b99212Da76ad316178A184AB56D299b43"],
  84532: ["0x492E6456D9528771018DeB9E87ef7750EF184104"],
};

export interface IndexerAddresses {
  factory: Lower;
  router: Lower;
  hook: Lower;
  poolManager: Lower;
  burnVault: Lower;
  floorVault: Lower;
  holderDistributor: Lower;
  /** Never holders: the zero address, dEaD and every memefun contract. Coins themselves are added per coin. */
  excluded: ReadonlySet<Lower>;
  knownRouters: ReadonlySet<Lower>;
}

export function indexerAddresses(d: Deployment, extraRouters: string[] = []): IndexerAddresses {
  return {
    factory: lc(d.factory),
    router: lc(d.router),
    hook: lc(d.hook),
    poolManager: lc(d.poolManager),
    burnVault: lc(d.buybackBurnVault),
    floorVault: lc(d.floorVault),
    holderDistributor: lc(d.holderRewardDistributor),
    excluded: new Set([ZERO, DEAD, ...protocolAddresses(d).map(lc)]),
    knownRouters: new Set([...(UNIVERSAL_ROUTERS[d.chainId] ?? []), ...extraRouters].map((a) => lc(getAddress(a)))),
  };
}

export function isExcludedHolder(addresses: IndexerAddresses, coin: string, account: string): boolean {
  const a = lc(account);
  return addresses.excluded.has(a) || a === lc(coin);
}

export type TradeKind = "trade" | "first_buy" | "buyback";

/**
 * Who a Trade belongs to. The hook emits the MemeFunRouter user, or the PoolManager caller for
 * everything else: the factory (the creator's first buy, inside the launch), the coin's own
 * buyback vault, or another router (then the transaction sender is the best attribution).
 */
export function attributeTrade(
  addresses: IndexerAddresses,
  input: { sender: string; launcher: string; txFrom: string },
): { trader: Lower; kind: TradeKind } {
  const sender = lc(input.sender);
  if (sender === addresses.factory) return { trader: lc(input.launcher), kind: "first_buy" };
  if (sender === addresses.burnVault) return { trader: sender, kind: "buyback" };
  if (addresses.knownRouters.has(sender)) return { trader: lc(input.txFrom), kind: "trade" };
  return { trader: sender, kind: "trade" };
}
