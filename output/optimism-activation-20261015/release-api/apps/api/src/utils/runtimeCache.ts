type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type CounterEntry = {
  count: number;
  expiresAt: number;
};

export class RuntimeCache {
  private readonly values = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly counters = new Map<string, CounterEntry>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  // Hard ceiling so a flood of unique keys (e.g. many IPs) can't grow the maps
  // without bound between sweeps. Generous — far above real concurrent usage.
  private static readonly MAX_ENTRIES = 250_000;

  get<T>(key: string): T | null {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number) {
    if (this.values.size > RuntimeCache.MAX_ENTRIES) {
      this.prune();
    }
    this.values.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
    const inflight = this.inflight.get(key);
    if (inflight) {
      return inflight as Promise<T>;
    }

    const promise = load().finally(() => {
      const current = this.inflight.get(key);
      if (current === promise) {
        this.inflight.delete(key);
      }
    });

    this.inflight.set(key, promise);
    return promise;
  }

  async getOrSet<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    return this.singleFlight(key, () =>
      load()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
    );
  }

  // Drop expired cache values and rate-limit counters. Never touches in-flight
  // promises. Cheap and safe to call periodically.
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.values) {
      if (entry.expiresAt <= now) {
        this.values.delete(key);
      }
    }
    for (const [key, entry] of this.counters) {
      if (entry.expiresAt <= now) {
        this.counters.delete(key);
      }
    }
  }

  // Start a background sweep (idempotent). `unref` so it never keeps the process
  // alive on its own.
  startEvictionLoop(intervalMs = 60_000) {
    if (this.evictionTimer) {
      return;
    }
    this.evictionTimer = setInterval(() => this.prune(), intervalMs);
    this.evictionTimer.unref?.();
  }

  consumeRateLimit(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    // Safety valve: if the counter map has ballooned, sweep expired entries
    // before adding more (defends against unique-key flooding between sweeps).
    if (this.counters.size > RuntimeCache.MAX_ENTRIES) {
      this.prune();
    }
    const existing = this.counters.get(key);

    if (!existing || existing.expiresAt <= now) {
      this.counters.set(key, {
        count: 1,
        expiresAt: now + windowMs,
      });

      return {
        allowed: true,
        count: 1,
        remaining: Math.max(0, limit - 1),
        retryAfterMs: 0,
      };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        count: existing.count,
        remaining: 0,
        retryAfterMs: Math.max(0, existing.expiresAt - now),
      };
    }

    existing.count += 1;
    this.counters.set(key, existing);

    return {
      allowed: true,
      count: existing.count,
      remaining: Math.max(0, limit - existing.count),
      retryAfterMs: 0,
    };
  }

  invalidate(key: string) {
    this.values.delete(key);
    this.inflight.delete(key);
    this.counters.delete(key);
  }

  invalidatePrefix(prefix: string) {
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix)) {
        this.values.delete(key);
      }
    }

    for (const key of [...this.inflight.keys()]) {
      if (key.startsWith(prefix)) {
        this.inflight.delete(key);
      }
    }

    for (const key of [...this.counters.keys()]) {
      if (key.startsWith(prefix)) {
        this.counters.delete(key);
      }
    }
  }
}

export const runtimeCache = new RuntimeCache();
