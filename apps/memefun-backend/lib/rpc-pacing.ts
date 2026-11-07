import { TimeoutError } from "viem";

/** A FIFO bounded by the outer transport: its default 30 RPS admits eight active requests. */
export function createRpcPacer({ intervalMs = 200, maxActive = 2, maxWaitMs = 10_000 } = {}) {
  const waiting: Array<{ start(release: () => void): void; fail(error: Error): void; check?: () => unknown; timer: ReturnType<typeof setTimeout> }> = [];
  let active = 0;
  let nextStart = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // TTL tests and operators can change wall time; pacing needs a monotonic clock.
  const now = () => performance.now();

  function pump() {
    clearTimeout(timer);
    timer = undefined;
    if (waiting.length === 0 || active >= maxActive) return;
    try { waiting[0]!.check?.(); }
    catch (error) {
      const entry = waiting.shift()!;
      clearTimeout(entry.timer);
      entry.fail(error instanceof Error ? error : new Error("RPC request unavailable."));
      pump();
      return;
    }
    const delay = nextStart - now();
    if (delay > 0) {
      timer = setTimeout(pump, Math.ceil(delay));
      return;
    }
    const entry = waiting.shift()!;
    clearTimeout(entry.timer);
    active += 1;
    nextStart = now() + intervalMs;
    let released = false;
    entry.start(() => {
      if (released) return;
      released = true;
      active -= 1;
      pump();
    });
    pump();
  }

  return {
    isReady: () => waiting.length === 0 && active < maxActive && now() >= nextStart,
    get pending() { return waiting.length; },
    get active() { return active; },
    acquire(check?: () => unknown): Promise<() => void> {
      return new Promise((start, fail) => {
        const entry = { start, fail, check, timer: setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index < 0) return;
          waiting.splice(index, 1);
          fail(new TimeoutError({ body: {}, url: "public RPC pacing queue" }));
          pump();
        }, maxWaitMs) };
        waiting.push(entry);
        pump();
      });
    },
  };
}
