import { createHmac } from "node:crypto";
import { createPublicClient, fallback, http } from "viem";

import { createAppStore } from "../lib/app-store";
import { chainSettings } from "../lib/chain";
import { createAppPool, createReadPool } from "../lib/db";
import { loadDeployment } from "../lib/deployment";
import { envList, optionalEnv, requireEnv } from "../lib/env";
import { lc } from "../lib/indexer/addresses";
import { createMediaStore } from "../lib/media";
import { migrate } from "../lib/migrate";
import type { AppDeps } from "./app";
import { normalizeOrigins } from "./http";
import { createSettingsReader } from "./read/settings";
import { MarketSnapshot } from "./read/snapshot";
import { createReadStore } from "./read/store";
import { LiveHub } from "./read/stream";
import { createSessions } from "./write/session";

export interface Running extends AppDeps {
  dispose(): Promise<void>;
}

/**
 * Everything the API needs, from the environment: two database pools, the chain client, the media
 * store, the market snapshot and the live hub. Applies pending memefun_app migrations first
 * (advisory-locked, so replicas starting together are safe).
 */
export async function createDeps(): Promise<Running> {
  const chain = chainSettings();
  const deployment = loadDeployment(chain.id);
  const readPool = createReadPool();
  const appPool = createAppPool();
  await migrate(appPool);

  const store = createReadStore(readPool);
  const app = createAppStore(appPool);
  const media = createMediaStore();
  const client = createPublicClient({ chain: chain.viemChain, transport: fallback(chain.rpcUrls.map((url) => http(url, { timeout: 10_000 }))) });
  const snapshot = new MarketSnapshot({ store, app, media });
  const hub = new LiveHub({ store, snapshot });

  const origins = envList("ALLOWED_ORIGINS");
  if (origins.length === 0 && chain.key !== "local") throw new Error("ALLOWED_ORIGINS is required outside the local chain.");
  const allowedOrigins = normalizeOrigins(origins.length > 0 ? origins : ["http://localhost:3100"]);
  const domains = new Set([...allowedOrigins].map((origin) => new URL(origin).host.toLowerCase()));

  const sessionSecret = requireEnv("SIWE_SESSION_SECRET");
  const sessions = createSessions(sessionSecret);
  // IP hashes use a salt derived from the session secret unless one is given.
  const ipSalt = optionalEnv("IP_HASH_SALT") ?? createHmac("sha256", sessionSecret).update("memefun ip salt").digest("hex");

  snapshot.start(2_000);
  hub.start(1_000);
  await snapshot.refresh().catch((error: unknown) => console.error("[memefun api] first snapshot failed", error));

  return {
    read: { snapshot, store, app, settings: createSettingsReader(client, deployment.config), poolManager: lc(deployment.poolManager) },
    write: { app, media, snapshot, sessions, ipSalt },
    auth: { pool: appPool, sessions, client, chainId: chain.id, domains, ipSalt },
    admin: { token: optionalEnv("ADMIN_TOKEN"), app, index: readPool, snapshot },
    hub,
    media,
    allowedOrigins,
    async dispose() {
      snapshot.stop();
      hub.stop();
      await Promise.allSettled([readPool.end(), appPool.end()]);
    },
  };
}
