import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCAL_CHAIN_ID } from "../lib/chain";
import { devAccount } from "../lib/dev";

/**
 * A fresh local Base chain with memefun deployed: base-anvil (Base's B20 precompiles), then
 * packages/memefun-contracts/script/DevDeploy.s.sol through base-forge, then the deployment record
 * copied into this service. Used by `pnpm dev:chain` and the e2e suite.
 */
export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = resolve(backendRoot, "../../packages/memefun-contracts");
const exe = process.platform === "win32" ? ".exe" : "";

export function baseFoundryBin(name: "anvil" | "forge"): string {
  const path = join(process.env.MEMEFUN_BASE_FOUNDRY_BIN ?? join(homedir(), ".base-foundry", "bin"), `${name}${exe}`);
  if (!existsSync(path)) throw new Error(`Base Foundry binary not found at ${path}. Install base-anvil or set MEMEFUN_BASE_FOUNDRY_BIN.`);
  return path;
}

export async function rpcUp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface LocalChain {
  rpcUrl: string;
  process: ChildProcess;
  stop(): void;
}

export async function startLocalChain(options: { port: number; logPath: string }): Promise<LocalChain> {
  const rpcUrl = `http://127.0.0.1:${options.port}`;
  if (await rpcUp(rpcUrl)) throw new Error(`Something is already answering on ${rpcUrl}. Stop it first (or use another port).`);
  mkdirSync(dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath);
  const anvil = spawn(
    baseFoundryBin("anvil"),
    ["--base", "--base-activation-admin", devAccount("deployer").address, "--host", "127.0.0.1", "--port", String(options.port), "--chain-id", String(LOCAL_CHAIN_ID)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  anvil.stdout?.pipe(log);
  anvil.stderr?.pipe(log);
  const stop = () => {
    if (anvil.exitCode === null && !anvil.killed) anvil.kill();
  };
  const deadline = Date.now() + 30_000;
  while (!(await rpcUp(rpcUrl))) {
    if (anvil.exitCode !== null || Date.now() > deadline) {
      stop();
      throw new Error(`base-anvil did not start; see ${options.logPath}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { rpcUrl, process: anvil, stop };
}

/** Deploys memefun with DevDeploy.s.sol and copies deployments/31337.json into this service. */
export function deployMemefun(rpcUrl: string): void {
  // --offline: without it forge looks up trace signatures online after the run and can hang.
  const forge = spawnSync(baseFoundryBin("forge"), ["script", "script/DevDeploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--offline"], {
    cwd: contractsDir,
    env: { ...process.env, FOUNDRY_BASE: "true", FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
    encoding: "utf8",
    timeout: 15 * 60_000,
  });
  if (forge.status !== 0 || !/ONCHAIN EXECUTION COMPLETE & SUCCESSFUL/.test(forge.stdout)) {
    throw new Error(`DevDeploy failed (exit ${forge.status}):\n${forge.stdout}\n${forge.stderr}`);
  }
  mkdirSync(join(backendRoot, "deployments"), { recursive: true });
  copyFileSync(join(contractsDir, "deployments", `${LOCAL_CHAIN_ID}.json`), join(backendRoot, "deployments", `${LOCAL_CHAIN_ID}.json`));
}

/**
 * Forgets everything Ponder cached about earlier local chains. Every `pnpm dev:chain` is a new
 * chain with the same id (31337), and Ponder's sync store (`ponder_sync`) keys its blocks, logs
 * and synced ranges by chain id, so without this `ponder dev` would replay the previous chain's
 * history. (`disableCache` only covers RPC request results.) Safe when the store does not exist.
 */
export async function purgeLocalSyncCache(databaseUrl: string): Promise<number> {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
        WHERE c.table_schema = 'ponder_sync' AND c.column_name = 'chain_id'`,
    );
    let removed = 0;
    for (const { table_name } of rows) {
      const result = await client.query(`DELETE FROM ponder_sync."${table_name}" WHERE chain_id = $1`, [LOCAL_CHAIN_ID]);
      removed += result.rowCount ?? 0;
    }
    return removed;
  } finally {
    await client.end();
  }
}
