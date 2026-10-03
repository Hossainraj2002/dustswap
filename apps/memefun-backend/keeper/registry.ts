import { type KeeperContext, withJobLock } from "./context";
import { runEpochs } from "./jobs/epochs";
import { runMetadata } from "./jobs/metadata";
import { runBuybacks, runFloors } from "./jobs/modules";
import { runStockPrices } from "./jobs/stockPrices";

/** Every keeper job and its schedule; each run takes the job's advisory lock. */
export interface Job {
  name: string;
  everyMs: number;
  run: (ctx: KeeperContext) => Promise<unknown>;
}

export const JOBS: Job[] = [
  { name: "metadata", everyMs: 15_000, run: runMetadata },
  { name: "buyback", everyMs: 60_000, run: runBuybacks },
  { name: "floor", everyMs: 5 * 60_000, run: runFloors },
  { name: "stock_prices", everyMs: 10 * 60_000, run: runStockPrices },
  { name: "epochs", everyMs: 60_000, run: runEpochs },
];

export async function runJobOnce(ctx: KeeperContext, job: Job): Promise<unknown> {
  const started = Date.now();
  try {
    const outcome = await withJobLock(ctx.appPool, job.name, () => job.run(ctx));
    if (!outcome.ran) {
      ctx.log("job.locked", { job: job.name });
      return undefined;
    }
    ctx.log("job.done", { job: job.name, ms: Date.now() - started, result: outcome.value });
    return outcome.value;
  } catch (error) {
    ctx.log("job.error", { job: job.name, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}
