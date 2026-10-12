import type { Job } from "./registry";

/** Run jobs on their existing schedules, keeping only timers that have not fired yet. */
export function startJobs(jobs: readonly Job[], run: (job: Job) => Promise<unknown>): () => void {
  let stopping = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const loop = (job: Job) => {
    if (stopping) return;
    void run(job).finally(() => {
      if (stopping) return;
      // Small jitter so many instances (or many jobs) do not wake in lockstep.
      const timer = setTimeout(() => {
        timers.delete(timer);
        loop(job);
      }, job.everyMs + Math.floor(Math.random() * 1_000));
      timers.add(timer);
    });
  };
  for (const job of jobs) loop(job);
  return () => {
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
