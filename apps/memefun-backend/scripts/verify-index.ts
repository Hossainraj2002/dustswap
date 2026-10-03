/**
 * Checks the index against the chain: every balance, price, fee ledger, module total and candle
 * the indexer wrote is compared with what the contracts return right now.
 *
 *   pnpm verify-index [--schema public]
 *
 * Run it while the indexer is caught up (no new blocks arriving), e.g. after `pnpm dev:chain`.
 */
import pg from "pg";
import { createPublicClient, http } from "viem";

import { chainSettings } from "../lib/chain";
import { loadDeployment } from "../lib/deployment";
import { loadLocalEnv, optionalEnv, requireEnv } from "../lib/env";
import { verifyIndexAgainstChain } from "../lib/verify/chain-truth";

async function main() {
  loadLocalEnv();
  const chain = chainSettings();
  const deployment = loadDeployment(chain.id);
  const schemaFlag = process.argv.indexOf("--schema");
  const schema = schemaFlag >= 0 ? process.argv[schemaFlag + 1]! : (optionalEnv("DATABASE_SCHEMA") ?? "public");
  const pool = new pg.Pool({ connectionString: requireEnv("DATABASE_URL"), max: 4 });
  const client = createPublicClient({ chain: chain.viemChain, transport: http(chain.rpcUrls[0]) });
  try {
    const report = await verifyIndexAgainstChain({ pool, schema, client, deployment });
    if (report.failures.length > 0) {
      console.error(`index differs from chain in ${report.failures.length} of ${report.checks} checks:`);
      for (const failure of report.failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log(`index matches chain: ${report.checks} checks over ${report.coins} coins`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
