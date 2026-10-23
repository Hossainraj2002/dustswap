import type { Job } from "./registry";

/** Run jobs on their existing schedules, keeping only timers that have not fired yet. */
export function startJobs(jobs: readonly Job[], run: (job: Job) => Promise<unknown>): () => Promise<void> {
  let stopping = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const running = new Set<Promise<unknown>>();
  const loop = (job: Job) => {
    if (stopping) return;
    // Keep the current jobs alive through shutdown so their advisory locks and any
    // submitted transactions settle before their database connections are closed.
    let task: Promise<unknown>;
    try { task = Promise.resolve(run(job)); }
    catch (error) { task = Promise.reject(error); }
    running.add(task);
    const settled = () => {
      running.delete(task);
      if (stopping) return;
      // Small jitter so many instances (or many jobs) do not wake in lockstep.
      const timer = setTimeout(() => {
        timers.delete(timer);
        loop(job);
      }, job.everyMs + Math.floor(Math.random() * 1_000));
      timers.add(timer);
    };
    // runJobOnce logs failures. A rejected runner must not create an unhandled
    // rejection or prevent its next scheduled attempt.
    void task.then(settled, settled);
  };
  for (const job of jobs) loop(job);
  return async () => {
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await Promise.allSettled([...running]);
  };
}
