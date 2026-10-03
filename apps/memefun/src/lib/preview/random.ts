/** Small deterministic PRNG (mulberry32) so preview data is identical on every load. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

export function between(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Log-normal sample: most values small, a long tail of large ones. */
export function logNormal(rng: () => number, median: number, sigma: number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return median * Math.exp(sigma * normal);
}

export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic 0x address from a seed (preview only). */
export function seededAddress(rng: () => number, prefix = ""): `0x${string}` {
  let hex = prefix.toLowerCase();
  while (hex.length < 40) hex += Math.floor(rng() * 16).toString(16);
  return `0x${hex.slice(0, 40)}`;
}

export function seededHash(rng: () => number): `0x${string}` {
  let hex = "";
  while (hex.length < 64) hex += Math.floor(rng() * 16).toString(16);
  return `0x${hex}`;
}
