// SYNCED from apps/memefun/src/core/milestones.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
/**
 * Market-cap milestones drive the milestone ring around every coin avatar and
 * the creator's share prompts. Progress is linear inside the current band so
 * "$18K of $25K" reads the way the ring looks.
 */
export const MILESTONES_USD = [
  10_000, 25_000, 69_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000,
  10_000_000, 25_000_000, 50_000_000, 100_000_000, 250_000_000, 500_000_000, 1_000_000_000,
] as const;

export interface MilestoneProgress {
  /** Last milestone reached, or the opening market cap if none yet. */
  floor: number;
  /** Next milestone, or null once every milestone is reached. */
  next: number | null;
  /** 0..1 progress from `floor` to `next`. */
  progress: number;
  reached: number;
}

export function milestoneProgress(marketCapUsd: number, openingFdvUsd: number): MilestoneProgress {
  const cap = Number.isFinite(marketCapUsd) ? Math.max(0, marketCapUsd) : 0;
  let reached = 0;
  for (const milestone of MILESTONES_USD) {
    if (cap >= milestone) reached += 1;
  }
  const next = MILESTONES_USD[reached] ?? null;
  const floor = reached > 0 ? (MILESTONES_USD[reached - 1] as number) : Math.min(openingFdvUsd, cap);
  if (next === null) return { floor, next: null, progress: 1, reached };
  const span = next - floor;
  const progress = span > 0 ? Math.min(1, Math.max(0, (cap - floor) / span)) : 0;
  return { floor, next, progress, reached };
}

/** True when moving from `before` to `after` crossed at least one milestone. */
export function crossedMilestone(beforeUsd: number, afterUsd: number): number | null {
  for (const milestone of MILESTONES_USD) {
    if (beforeUsd < milestone && afterUsd >= milestone) return milestone;
  }
  return null;
}

export function milestoneLabel(usd: number): string {
  if (usd >= 1_000_000_000) return `$${usd / 1_000_000_000}B`;
  if (usd >= 1_000_000) return `$${usd / 1_000_000}M`;
  return `$${usd / 1_000}K`;
}
