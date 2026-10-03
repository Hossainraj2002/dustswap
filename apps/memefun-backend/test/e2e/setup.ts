import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";

import { migrate } from "../../lib/migrate";
import { backendRoot, deployMemefun, startLocalChain } from "../../scripts/local-chain";
import { seed } from "../../scripts/seed";

/**
 * The whole stack, isolated from development: a fresh base-anvil on :8546 with memefun deployed
 * and seeded, its own database (memefun_e2e), Ponder in production mode (`ponder start`) serving
 * the API on :42070, and a temporary media directory. Torn down afterwards.
 */
export interface E2EContext {
  apiUrl: string;
  rpcUrl: string;
  databaseUrl: string;
  schema: string;
  mediaDir: string;
  adminToken: string;
  origin: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    e2e: E2EContext;
  }
}

const RPC_PORT = 8546;
const API_PORT = 42070;
const ADMIN_URL = process.env.MEMEFUN_E2E_ADMIN_DB_URL ?? "postgres://memefun:memefun@127.0.0.1:54329/memefun";
const DATABASE = "memefun_e2e";

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`e2e: timed out waiting for ${what}`);
}

export default async function setup(project: TestProject) {
  const logs = join(backendRoot, "data", "e2e");
  mkdirSync(logs, { recursive: true });

  // Database: a brand-new one per run.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect().catch((error: unknown) => {
    throw new Error(`e2e needs the dev Postgres (pnpm dev:db): ${error instanceof Error ? error.message : error}`);
  });
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  await admin.end();
  const databaseUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${DATABASE}`);

  const mediaDir = mkdtempSync(join(tmpdir(), "memefun-e2e-media-"));
  const context: E2EContext = {
    apiUrl: `http://localhost:${API_PORT}`,
    rpcUrl: `http://127.0.0.1:${RPC_PORT}`,
    databaseUrl,
    schema: "e2e",
    mediaDir,
    adminToken: randomBytes(32).toString("hex"),
    origin: "http://localhost:3100",
  };
  const env = {
    ...process.env,
    MEMEFUN_CHAIN: "local",
    MEMEFUN_RPC_URLS: context.rpcUrl,
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: context.schema,
    MEDIA_STORE: "local",
    MEDIA_LOCAL_DIR: mediaDir,
    PUBLIC_API_URL: context.apiUrl,
    ALLOWED_ORIGINS: context.origin,
    SIWE_SESSION_SECRET: randomBytes(32).toString("hex"),
    ADMIN_TOKEN: context.adminToken,
    PORT: String(API_PORT),
  };
  Object.assign(process.env, env);

  // Chain: deploy and seed.
  const chain = await startLocalChain({ port: RPC_PORT, logPath: join(logs, "anvil.log") });
  let ponder: ChildProcess | null = null;
  const teardown = async () => {
    if (ponder && ponder.exitCode === null) {
      ponder.kill();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    chain.stop();
    rmSync(mediaDir, { recursive: true, force: true });
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
    await cleanup.end();
  };

  try {
    deployMemefun(context.rpcUrl);
    await seed({ rpcUrl: context.rpcUrl });

    const appPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await migrate(appPool);
    await appPool.end();

    // Ponder in production mode. stdin stays open: on Windows Ponder exits when stdin closes.
    const log = createWriteStream(join(logs, "ponder.log"));
    ponder = spawn(process.execPath, [join(backendRoot, "node_modules/ponder/dist/esm/bin/ponder.js"), "start", "--schema", context.schema, "--port", String(API_PORT)], {
      cwd: backendRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    ponder.stdout?.pipe(log);
    ponder.stderr?.pipe(log);
    await waitFor("Ponder /ready", async () => (await fetch(`${context.apiUrl}/ready`)).status === 200, 180_000);
    await waitFor("the API snapshot", async () => (await fetch(`${context.apiUrl}/v1/health`)).status === 200, 60_000);
  } catch (error) {
    await teardown();
    throw error;
  }

  project.provide("e2e", context);
  return teardown;
}
