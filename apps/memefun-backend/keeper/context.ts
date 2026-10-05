import type pg from "pg";
import { type Account, type Address, type Hex, type PublicClient, type WalletClient, createPublicClient, createWalletClient, fallback, http, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { type AppStore, createAppStore } from "../lib/app-store";
import { type ChainSettings, chainSettings } from "../lib/chain";
import { createAppPool, createReadPool } from "../lib/db";
import { type Deployment, loadDeployment } from "../lib/deployment";
import { devAccount } from "../lib/dev";
import { envBool, envInt, optionalEnv } from "../lib/env";
import { createMediaStore } from "../lib/media";
import type { MediaStore } from "../lib/media/store";
import { type PriceSource, createPriceSource } from "./prices";
import { keeperAttribution } from "./builderCode";

/**
 * What every keeper job gets. One key per role, so a leaked key is bounded by what that role can do
 * on chain: the keeper key only triggers buybacks and floors (anyone may), the price keeper can move
 * a stock price at most 20% per update, and the publisher's epochs can be vetoed for 12 hours.
 */
export interface KeeperContext {
  chain: ChainSettings;
  deployment: Deployment;
  client: PublicClient;
  wallets: { keeper?: WalletClient; priceKeeper?: WalletClient; publisher?: WalletClient };
  index: pg.Pool;
  appPool: pg.Pool;
  app: AppStore;
  media: MediaStore;
  prices: PriceSource;
  dryRun: boolean;
  thresholds: { buybackMinUsdE8: bigint; floorMinUsdE8: bigint; rewardDustUsdE8: bigint };
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Latest block time: the clock every cooldown and epoch boundary is measured against. */
  chainNow(): Promise<number>;
}

function keyAccount(name: string, chainKey: ChainSettings["key"], devRole: Parameters<typeof devAccount>[0]): Account | undefined {
  const raw = optionalEnv(name);
  if (raw) {
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    if (!isHex(key) || key.length !== 66) throw new Error(`${name} is not a 32-byte private key.`);
    return privateKeyToAccount(key);
  }
  // Only the local chain falls back to anvil's public dev keys.
  return chainKey === "local" ? devAccount(devRole) : undefined;
}

export function jsonLog(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), service: "keeper", event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function createKeeperContext(): KeeperContext {
  const dataSuffix = keeperAttribution();
  const chain = chainSettings();
  const deployment = loadDeployment(chain.id);
  const transport = fallback(chain.rpcUrls.map((url) => http(url, { timeout: 15_000 })));
  const client = createPublicClient({ chain: chain.viemChain, transport });
  const wallet = (account: Account | undefined) => (account ? createWalletClient({ chain: chain.viemChain, transport, account, dataSuffix }) : undefined);
  const appPool = createAppPool({ max: 4 });
  return {
    chain,
    deployment,
    client,
    wallets: {
      keeper: wallet(keyAccount("KEEPER_PRIVATE_KEY", chain.key, "deployer")),
      priceKeeper: wallet(keyAccount("PRICE_KEEPER_PRIVATE_KEY", chain.key, "priceKeeper")),
      publisher: wallet(keyAccount("REWARDS_PUBLISHER_PRIVATE_KEY", chain.key, "publisher")),
    },
    index: createReadPool({ max: 4, statementTimeoutMs: 30_000 }),
    appPool,
    app: createAppStore(appPool),
    media: createMediaStore(),
    prices: createPriceSource(chain.key),
    dryRun: envBool("KEEPER_DRY_RUN", false),
    thresholds: {
      buybackMinUsdE8: BigInt(envInt("BUYBACK_MIN_USD_CENTS", chain.key === "local" ? 50 : 500, { min: 1 })) * 1_000_000n,
      floorMinUsdE8: BigInt(envInt("FLOOR_MIN_USD_CENTS", chain.key === "local" ? 50 : 1_000, { min: 1 })) * 1_000_000n,
      rewardDustUsdE8: 1_000_000n, // $0.01
    },
    log: jsonLog,
    async chainNow() {
      return Number((await client.getBlock()).timestamp);
    },
  };
}

/**
 * Runs `fn` only if this process gets the job's advisory lock, so several keeper instances never
 * act twice. The lock is session-level and released when `fn` ends.
 */
export async function withJobLock<T>(pool: pg.Pool, job: string, fn: () => Promise<T>, signerLocks: readonly string[] = []): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await pool.connect();
  const acquired: string[] = [];
  try {
    for (const key of [...new Set([`memefun_keeper:${job}`, ...signerLocks])].sort()) {
      const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key]);
      if (!rows[0]?.locked) return { ran: false };
      acquired.push(key);
    }
    return { ran: true, value: await fn() };
  } finally {
    await releaseJobLocks(client, acquired);
  }
}

async function releaseJobLocks(client: pg.PoolClient, acquired: string[]) {
  let unlockFailed = false;
  try {
    for (const key of acquired.reverse()) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
  } catch (error) {
    unlockFailed = true;
    throw error;
  } finally {
    // A pooled connection with unreleased session locks must never be reused.
    client.release(unlockFailed);
  }
}

export function addressOf(wallet: WalletClient | undefined): Address | undefined {
  return wallet?.account?.address;
}
