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
import { pathToFileURL } from "node:url";
import { migrate } from "../lib/migrate";
import { addressOf, createKeeperContext, jsonLog } from "./context";
import { JOBS, runJobOnce } from "./registry";
import { startJobs } from "./scheduler";
import { waitForIndexer } from "./wake";

export async function runKeeper(args: readonly string[] = process.argv.slice(2)): Promise<(() => Promise<void>) | undefined> {
  loadLocalEnv();
  const only = args.indexOf("--job");
  const selected = only >= 0 ? JOBS.filter((job) => job.name === args[only + 1]) : JOBS;
  if (only >= 0 && selected.length === 0) throw new Error(`Unknown job "${args[only + 1]}". Jobs: ${JOBS.map((j) => j.name).join(", ")}.`);

  const ctx = createKeeperContext();
  let stopping = false;
  let stopJobs: (() => Promise<void>) | undefined;
  let active: Promise<unknown> = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping = true;
    shutdownPromise ??= (async () => {
      ctx.log("keeper.stop");
      await Promise.allSettled([active, stopJobs?.()]);
      await Promise.allSettled([ctx.index.end(), ctx.appPool.end()]);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    })();
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown().catch((error: unknown) => {
      jsonLog("keeper.fatal", { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    active = migrate(ctx.appPool);
    await active;
    if (stopping) { await shutdown(); return; }
    active = waitForIndexer(ctx);
    await active;
    if (stopping) { await shutdown(); return; }
    ctx.log("keeper.start", {
      chain: ctx.chain.key,
      dryRun: ctx.dryRun,
      keeper: addressOf(ctx.wallets.keeper) ?? null,
      priceKeeper: addressOf(ctx.wallets.priceKeeper) ?? null,
      publisher: addressOf(ctx.wallets.publisher) ?? null,
      prices: ctx.prices.kind,
    });

    if (args.includes("--once") || only >= 0) {
      const failures: string[] = [];
      for (const job of selected) {
        if (stopping) break;
        active = runJobOnce(ctx, job, { throwOnError: true });
        try { await active; }
        catch { failures.push(job.name); }
      }
      await shutdown();
      if (failures.length) throw new Error(`Keeper pass failed for: ${failures.join(", ")}. See job.error logs.`);
      return;
    }

    stopJobs = startJobs(selected, (job) => runJobOnce(ctx, job));
    return shutdown;
  } catch (error) {
    await shutdown();
    throw error;
  }
}

// Importing the lifecycle in tests must never start a real wallet or database client.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runKeeper().catch((error: unknown) => {
    jsonLog("keeper.fatal", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
