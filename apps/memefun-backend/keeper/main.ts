/**
 * The memefun keeper: buybacks, floors, stock prices, holder-reward epochs and coin metadata.
 *
 *   pnpm keeper                 run every job on its schedule until stopped
 *   pnpm keeper --once          run every job once and exit (scripts, tests)
 *   pnpm keeper --job epochs    run one job once and exit
 *
 * Several instances may run: each job takes a Postgres advisory lock, so only one acts at a time.
 * KEEPER_DRY_RUN=true simulates every transaction and sends none.
 */
import { loadLocalEnv } from "../lib/env";
import { migrate } from "../lib/migrate";
import { addressOf, createKeeperContext, jsonLog } from "./context";
import { type Job, JOBS, runJobOnce } from "./registry";

async function main() {
  loadLocalEnv();
  const ctx = createKeeperContext();
  await migrate(ctx.appPool);
  ctx.log("keeper.start", {
    chain: ctx.chain.key,
    dryRun: ctx.dryRun,
    keeper: addressOf(ctx.wallets.keeper) ?? null,
    priceKeeper: addressOf(ctx.wallets.priceKeeper) ?? null,
    publisher: addressOf(ctx.wallets.publisher) ?? null,
    prices: ctx.prices.kind,
  });

  const only = process.argv.indexOf("--job");
  const selected = only >= 0 ? JOBS.filter((job) => job.name === process.argv[only + 1]) : JOBS;
  if (only >= 0 && selected.length === 0) throw new Error(`Unknown job "${process.argv[only + 1]}". Jobs: ${JOBS.map((j) => j.name).join(", ")}.`);

  if (process.argv.includes("--once") || only >= 0) {
    for (const job of selected) await runJobOnce(ctx, job);
    await Promise.allSettled([ctx.index.end(), ctx.appPool.end()]);
    return;
  }

  let stopping = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const loop = (job: Job) => {
    if (stopping) return;
    void runJobOnce(ctx, job).finally(() => {
      // Small jitter so many instances (or many jobs) do not wake in lockstep.
      if (!stopping) timers.push(setTimeout(() => loop(job), job.everyMs + Math.floor(Math.random() * 1_000)));
    });
  };
  for (const job of selected) loop(job);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    ctx.log("keeper.stop");
    for (const timer of timers) clearTimeout(timer);
    await Promise.allSettled([ctx.index.end(), ctx.appPool.end()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  jsonLog("keeper.fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
