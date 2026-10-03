/**
 * A fresh local Base chain with memefun deployed and seeded:
 *
 *   1. starts base-anvil (Base's B20 precompiles) on 127.0.0.1:8545 with an empty state
 *   2. deploys everything with packages/memefun-contracts/script/DevDeploy.s.sol (base-forge)
 *   3. copies deployments/31337.json into this service
 *   4. seeds a small market (scripts/seed.ts), unless --no-seed
 *
 * and keeps the chain running until Ctrl+C. Restarting gives a brand-new chain; `ponder dev`
 * re-indexes from scratch on every start, so the two always agree.
 *
 *   pnpm dev:chain [--no-seed] [--port 8545]
 *
 * Base's Foundry build lives in ~/.base-foundry/bin (override with MEMEFUN_BASE_FOUNDRY_BIN).
 */
import { join } from "node:path";

import { loadLocalEnv } from "../lib/env";
import { backendRoot, deployMemefun, startLocalChain } from "./local-chain";
import { seed } from "./seed";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  loadLocalEnv(backendRoot);
  const logPath = join(backendRoot, "data", "anvil.log");
  const chain = await startLocalChain({ port: Number(argValue("--port") ?? 8545), logPath });
  const stop = () => {
    chain.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  chain.process.on("exit", (code) => {
    console.error(`base-anvil exited (code ${code}); see ${logPath}`);
    process.exit(1);
  });
  console.log(`base-anvil up on ${chain.rpcUrl} (log: ${logPath})`);

  try {
    console.log("deploying memefun with DevDeploy.s.sol ...");
    deployMemefun(chain.rpcUrl);
    console.log("deployed; deployments/31337.json updated");
    if (!process.argv.includes("--no-seed")) await seed({ rpcUrl: chain.rpcUrl });
  } catch (error) {
    chain.stop();
    throw error;
  }
  console.log(`\nlocal chain ready on ${chain.rpcUrl}. Ctrl+C stops it (the next run starts fresh).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
