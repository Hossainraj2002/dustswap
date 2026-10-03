/**
 * Holder rewards, the arithmetic part. Pure and deterministic: the same transfers, window and pot
 * always give the same leaves, so anyone can recompute a published epoch from chain data.
 *
 * A holder's weight is their time-weighted balance over the window: the sum over every interval
 * between transfers of (balance x seconds held). Buying a minute before the window ends earns a
 * minute's worth, not a whole epoch's.
 */

export interface TransferEvent {
  from: string;
  to: string;
  amount: bigint;
  timestamp: number;
}

export interface WindowResult {
  /** balance x seconds, per account (excluded accounts are never present). */
  weights: Map<string, bigint>;
  totalWeight: bigint;
  /** Every account's balance at the window's end, excluded accounts included. */
  endBalances: Map<string, bigint>;
}

/**
 * @param startBalances balances at `windowStart` (all accounts).
 * @param transfers transfers with windowStart <= timestamp < windowEnd, in chain order.
 * @param excluded lowercase addresses that never earn (pool, dEaD, protocol contracts, the coin).
 */
export function timeWeightedBalances(input: {
  startBalances: ReadonlyMap<string, bigint>;
  transfers: readonly TransferEvent[];
  windowStart: number;
  windowEnd: number;
  excluded: ReadonlySet<string>;
}): WindowResult {
  const { windowStart, windowEnd } = input;
  if (windowEnd <= windowStart) throw new RangeError("window must have a positive length");
  const balances = new Map(input.startBalances);
  const lastChange = new Map<string, number>();
  const weights = new Map<string, bigint>();

  const accrue = (account: string, until: number) => {
    const balance = balances.get(account) ?? 0n;
    const since = lastChange.get(account) ?? windowStart;
    if (balance > 0n && until > since && !input.excluded.has(account)) {
      weights.set(account, (weights.get(account) ?? 0n) + balance * BigInt(until - since));
    }
    lastChange.set(account, until);
  };

  for (const t of input.transfers) {
    if (t.timestamp < windowStart || t.timestamp >= windowEnd) throw new RangeError(`transfer at ${t.timestamp} is outside the window`);
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    accrue(from, t.timestamp);
    accrue(to, t.timestamp);
    balances.set(from, (balances.get(from) ?? 0n) - t.amount);
    balances.set(to, (balances.get(to) ?? 0n) + t.amount);
  }
  for (const account of balances.keys()) accrue(account, windowEnd);

  let totalWeight = 0n;
  for (const [account, weight] of weights) {
    if (weight <= 0n) weights.delete(account);
    else totalWeight += weight;
  }
  return { weights, totalWeight, endBalances: balances };
}

export interface Allocation {
  account: string;
  amount: bigint;
}

/**
 * Splits `pot` pro rata to weight, rounding every share down, then drops shares below `minAmount`
 * (dust worth less than claiming it). What is not handed out stays in the coin's pot on chain for
 * the next epoch. Sorted by account, so leaf order is reproducible.
 */
export function allocate(pot: bigint, weights: ReadonlyMap<string, bigint>, minAmount: bigint): Allocation[] {
  let total = 0n;
  for (const weight of weights.values()) total += weight;
  if (pot <= 0n || total <= 0n) return [];
  const out: Allocation[] = [];
  for (const [account, weight] of [...weights.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const amount = (pot * weight) / total;
    if (amount > 0n && amount >= minAmount) out.push({ account, amount });
  }
  return out;
}

/** Holder-reward windows end at 00:00 and 12:00 UTC. */
export const EPOCH_LENGTH_SEC = 12 * 60 * 60;

export function latestBoundary(nowSec: number): number {
  return Math.floor(nowSec / EPOCH_LENGTH_SEC) * EPOCH_LENGTH_SEC;
}
