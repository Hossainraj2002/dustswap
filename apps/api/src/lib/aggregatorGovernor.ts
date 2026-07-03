/**
 * Aggregator API governor — shared pacing for external quote APIs (KyberSwap, 0x, LI.FI,
 * OpenOcean, Odos), which are all RPS-limited on free/low tiers.
 *
 * ADDITIVE + STANDALONE: quote candidate functions keep their own fetch/validation logic; this
 * module only decides WHEN a call may run and remembers recent results:
 *   - per-provider serial queue with a minimum interval between call starts,
 *   - load shedding: if the queue is already so deep the call would start after `MAX_QUEUE_WAIT_MS`,
 *     it is skipped (returns null) instead of stacking — a late aggregator quote is useless
 *     because the per-token quote task has its own hard timeout,
 *   - circuit breaker: an HTTP 429 (reported by the candidate fn via reportAggregatorHttpStatus)
 *     opens the breaker for a cool-off window during which calls are skipped instead of burning
 *     the provider's rate limit further,
 *   - short result cache + in-flight dedupe keyed by (provider, tokenIn, tokenOut, exact amountIn):
 *     the UI re-quotes the whole basket on every token add/remove, so unchanged tokens hit the
 *     cache instead of the API. The key uses the EXACT amount because aggregator calldata embeds it.
 */

export type AggregatorProviderId = "kyber" | "zerox" | "lifi" | "openocean" | "odos";

const DEFAULT_MIN_INTERVAL_MS: Record<AggregatorProviderId, number> = {
  kyber: 350, // keyless public tier is comparatively generous
  zerox: 600,
  lifi: 600,
  openocean: 1_100, // public tier is ~1 rps
  odos: 1_100, // public tier is aggressively limited without an API key
};

const BREAKER_COOL_OFF_MS = 60_000;
const CACHE_TTL_MS = 45_000;
const NO_ROUTE_CACHE_TTL_MS = 30_000;
const MAX_QUEUE_WAIT_MS = 8_000;
const CACHE_SWEEP_INTERVAL_MS = 60_000;

function envMinIntervalMs(provider: AggregatorProviderId) {
  const raw = Number(process.env[`DUST_SWEEP_AGG_MIN_INTERVAL_MS_${provider.toUpperCase()}`]);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(30_000, Math.round(raw));
  return DEFAULT_MIN_INTERVAL_MS[provider];
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

class ProviderGovernor {
  private queueTail: Promise<void> = Promise.resolve();
  private nextSlotAt = 0;
  private breakerOpenUntil = 0;

  constructor(private readonly provider: AggregatorProviderId) {}

  isBreakerOpen() {
    return Date.now() < this.breakerOpenUntil;
  }

  tripBreaker() {
    this.breakerOpenUntil = Date.now() + BREAKER_COOL_OFF_MS;
    console.warn(
      `[dustsweep/aggregator] ${this.provider} rate-limited (429) — pausing calls for ${BREAKER_COOL_OFF_MS / 1000}s`,
    );
  }

  /**
   * Run `fn` at the provider's pace (serialized, min interval between call starts), or return
   * null without running it when the breaker is open or the queue is already too deep.
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.isBreakerOpen()) return null;

    const now = Date.now();
    const projectedStart = Math.max(now, this.nextSlotAt);
    if (projectedStart - now > MAX_QUEUE_WAIT_MS) return null; // shed instead of stacking
    this.nextSlotAt = projectedStart + envMinIntervalMs(this.provider);

    const previous = this.queueTail;
    let release: () => void = () => {};
    this.queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const wait = projectedStart - Date.now();
      if (wait > 0) await sleep(wait);
      if (this.isBreakerOpen()) return null;
      return await fn();
    } finally {
      release();
    }
  }
}

const governors = new Map<AggregatorProviderId, ProviderGovernor>();

type CacheEntry = { value: unknown; expiresAt: number };
const resultCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
let lastCacheSweepAt = 0;

function getGovernor(provider: AggregatorProviderId) {
  let governor = governors.get(provider);
  if (!governor) {
    governor = new ProviderGovernor(provider);
    governors.set(provider, governor);
  }
  return governor;
}

function sweepCacheIfDue() {
  const now = Date.now();
  if (now - lastCacheSweepAt < CACHE_SWEEP_INTERVAL_MS) return;
  lastCacheSweepAt = now;
  for (const [key, entry] of resultCache) {
    if (entry.expiresAt <= now) resultCache.delete(key);
  }
}

/**
 * Candidate functions call this after each fetch so a 429 opens the provider's breaker.
 * Any other status is ignored — normal validation stays in the candidate function.
 */
export function reportAggregatorHttpStatus(provider: AggregatorProviderId, status: number) {
  if (status === 429) getGovernor(provider).tripBreaker();
}

/**
 * Governed call wrapper: cache → in-flight dedupe → breaker/pace → run → cache result.
 * Returns null when the provider is cooling off or the queue is too deep right now; those
 * nulls are NOT cached (a later attempt should retry), while a null from `fn` itself
 * ("no route") is cached briefly.
 */
export async function governAggregatorCall<T>(
  provider: AggregatorProviderId,
  cacheKey: string,
  fn: () => Promise<T | null>,
): Promise<T | null> {
  sweepCacheIfDue();
  const key = `${provider}:${cacheKey}`;

  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T | null;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T | null>;

  let ran = false;
  const tracked = (async () => {
    let value: T | null = null;
    try {
      value = await getGovernor(provider).schedule(async () => {
        ran = true;
        return fn();
      });
    } finally {
      inFlight.delete(key);
    }
    if (ran) {
      resultCache.set(key, {
        value,
        expiresAt: Date.now() + (value === null ? NO_ROUTE_CACHE_TTL_MS : CACHE_TTL_MS),
      });
    }
    return value;
  })();

  inFlight.set(key, tracked as Promise<unknown>);
  return tracked;
}
