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

  consumeRateLimit(key: string, limit: number, windowMs: number) {
    const now = Date.now();
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
