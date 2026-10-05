import { type KeeperContext, withJobLock } from "./context";
import { runEpochs } from "./jobs/epochs";
import { runMetadata } from "./jobs/metadata";
import { runBuybacks, runFloors } from "./jobs/modules";
import { runStockPrices } from "./jobs/stockPrices";
import { createSerialExecutor } from "./serial";

const mutationQueues = new WeakMap<KeeperContext, ReturnType<typeof createSerialExecutor>>();

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
  if (job.name === "metadata") return executeJob(ctx, job, []);
  let serial = mutationQueues.get(ctx);
  if (!serial) { serial = createSerialExecutor(); mutationQueues.set(ctx, serial); }
  // Price, publisher and module roles may share one testnet signer. Across replicas,
  // acquire signer locks on the existing job-lock connection, not a second pool client.
  const signerLocks = [...new Set(Object.values(ctx.wallets).flatMap(wallet => wallet?.account?.address
    ? [`memefun_keeper_signer:${ctx.chain.id}:${wallet.account.address.toLowerCase()}`] : []))];
  return serial(() => executeJob(ctx, job, signerLocks));
}

async function executeJob(ctx: KeeperContext, job: Job, signerLocks: string[]): Promise<unknown> {
  const started = Date.now();
  try {
    const outcome = await withJobLock(ctx.appPool, job.name, () => job.run(ctx), signerLocks);
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
