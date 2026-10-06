import { createHmac } from "node:crypto";
import { createPublicClient, fallback, http } from "viem";

import { createAppStore } from "../lib/app-store";
import { chainSettings } from "../lib/chain";
import { createAppPool, createReadPool } from "../lib/db";
import { loadDeployment } from "../lib/deployment";
import { envInt, envList, optionalEnv, requireEnv } from "../lib/env";
import { lc } from "../lib/indexer/addresses";
import { createMediaStore } from "../lib/media";
import { migrate } from "../lib/migrate";
import { createTweetAttestor } from "../lib/x/attestation";
import { createXOAuth } from "../lib/x/oauth";
import { createTweetProvider } from "../lib/x/provider";
import { createXStore } from "../lib/x/store";
import { createPairCatalog } from "../lib/market/pair-catalog";
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
  const settings = createSettingsReader(client, deployment.config);
  const pairCatalog = createPairCatalog({ chainId: chain.id, client, apiKey: optionalEnv("O1_API_KEY"), registry: async () => {
    const [state, currentSettings] = await Promise.all([snapshot.ready(), settings.get()]);
    return { quotes: [...state.quotes.values()], settings: currentSettings, nowSec: state.nowSec };
  } });

  const origins = envList("ALLOWED_ORIGINS");
  if (origins.length === 0 && chain.key !== "local") throw new Error("ALLOWED_ORIGINS is required outside the local chain.");
  const allowedOrigins = normalizeOrigins(origins.length > 0 ? origins : ["http://localhost:3100"]);
  const domains = new Set([...allowedOrigins].map((origin) => new URL(origin).host.toLowerCase()));

  const sessionSecret = requireEnv("SIWE_SESSION_SECRET");
  const sessions = createSessions(sessionSecret);
  // IP hashes use a salt derived from the session secret unless one is given.
  const ipSalt = optionalEnv("IP_HASH_SALT") ?? createHmac("sha256", sessionSecret).update("memefun ip salt").digest("hex");
  const xStore = createXStore(appPool);
  const getxKey = optionalEnv("GETX_API_KEY") ?? optionalEnv("GETXAPI_API_KEY") ?? optionalEnv("GETXAPI_KEY");
  const xClientId = optionalEnv("X_CLIENT_ID");
  const xRedirectUri = optionalEnv("X_REDIRECT_URI");
  const author = {
    store: xStore,
    provider: createTweetProvider(getxKey ? { apiKey: getxKey, dailyLimit: envInt("GETX_TWEET_DAILY_LIMIT", 100, { min: 0, max: 10_000 }) } : null, xStore),
    oauth: createXOAuth(xClientId && xRedirectUri ? { clientId: xClientId, clientSecret: optionalEnv("X_CLIENT_SECRET"), redirectUri: xRedirectUri,
      dailyLimit: envInt("X_AUTHOR_VERIFY_DAILY_LIMIT", 10, { min: 0, max: 10_000 }) } : null, xStore),
    attestor: createTweetAttestor(optionalEnv("TWEET_ATTESTOR_PRIVATE_KEY"), client, deployment),
    sessions, snapshot, origins: allowedOrigins, deployment, ipSalt,
  };
  const xPrune = setInterval(() => { void xStore.prune().catch(() => console.error("[memefun api] X state cleanup failed")); }, 60_000);
  xPrune.unref();

  snapshot.start(2_000);
  hub.start(1_000);
  await snapshot.refresh().catch((error: unknown) => console.error("[memefun api] first snapshot failed", error));

  return {
    read: { snapshot, store, app, settings, pairCatalog, poolManager: lc(deployment.poolManager) },
    write: { app, media, snapshot, sessions, ipSalt, chainId: chain.id },
    auth: { pool: appPool, sessions, client, chainId: chain.id, domains, ipSalt },
    admin: { token: optionalEnv("ADMIN_TOKEN"), app, index: readPool, snapshot },
    hub,
    media,
    allowedOrigins,
    deployment,
    author,
    async dispose() {
      clearInterval(xPrune);
      snapshot.stop();
      hub.stop();
      await Promise.allSettled([readPool.end(), appPool.end()]);
    },
  };
}
