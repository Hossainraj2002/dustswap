interface CachedPng {
  expiresAt: number;
  png: Buffer;
}

interface PngCacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  maxPending?: number;
}

/** Fixed-TTL LRU with byte bounds; expired images are released even without another request. */
export class PngCache {
  private readonly entries = new Map<string, CachedPng>();
  private readonly pending = new Map<string, Promise<Buffer>>();
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly maxPending: number;

  constructor(private readonly options: PngCacheOptions) {
    this.maxPending = options.maxPending ?? options.maxEntries;
    for (const value of [options.ttlMs, options.maxEntries, options.maxBytes, this.maxPending]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("PNG cache limits must be positive integers.");
    }
    if (options.ttlMs > 2_147_483_647) throw new Error("PNG cache TTL exceeds the timer limit.");
  }

  get size() { return this.entries.size; }
  get byteLength() { return this.bytes; }
  get pendingCount() { return this.pending.size; }

  getOrCreate(key: string, create: () => Promise<Buffer>): Promise<Buffer> {
    this.pruneExpired();
    const hit = this.entries.get(key);
    if (hit) {
      // Touch the LRU order without extending the freshness deadline.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return Promise.resolve(hit.png);
    }
    const existing = this.pending.get(key);
    if (existing) return existing;

    const task = Promise.resolve().then(create).then((png) => {
      this.put(key, png);
      return png;
    });
    // Do not retain a queue for arbitrary unique keys or add new HTTP failures. At capacity,
    // distinct requests render normally; only the cache's deduplication bookkeeping is bypassed.
    if (this.pending.size < this.maxPending) {
      this.pending.set(key, task);
      const release = () => { if (this.pending.get(key) === task) this.pending.delete(key); };
      void task.then(release, release);
    }
    return task;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private remove(key: string, entry: CachedPng) {
    this.entries.delete(key);
    this.bytes -= entry.png.byteLength;
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key, entry);
    }
  }

  private put(key: string, png: Buffer) {
    this.pruneExpired();
    // Return large render results to the requester, but do not let one image evict the cache.
    if (png.byteLength > this.options.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) this.remove(key, previous);
    while (this.entries.size >= this.options.maxEntries || this.bytes + png.byteLength > this.options.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
    this.entries.set(key, { png, expiresAt: Date.now() + this.options.ttlMs });
    this.bytes += png.byteLength;
    this.scheduleExpiry();
  }

  private scheduleExpiry() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.entries.size === 0) return;
    let nextExpiry = Infinity;
    for (const entry of this.entries.values()) nextExpiry = Math.min(nextExpiry, entry.expiresAt);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pruneExpired();
      this.scheduleExpiry();
    }, Math.max(1, nextExpiry - Date.now()));
    this.timer.unref();
  }
}
