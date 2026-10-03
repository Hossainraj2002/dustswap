import { BPS } from "./constants";

export interface LaunchProtection {
  /** Total fee at the moment of launch, in bps. */
  startBps: number;
  /** Seconds for the fee to decay linearly to the coin's normal fee. */
  durationSec: number;
}

/**
 * Fee in bps for a trade `elapsedSec` whole seconds after launch.
 *
 * Canonical schedule (the hook computes the same integer formula from
 * block.timestamp): surcharge = (start - base) * (duration - elapsed) / duration,
 * rounded down. The creator's first buy executes inside the launch
 * transaction and is exempt, so it always pays `baseFeeBps`.
 */
export function launchFeeBps(
  baseFeeBps: number,
  protection: LaunchProtection,
  elapsedSec: number,
): number {
  const elapsed = Math.max(0, Math.floor(elapsedSec));
  const { startBps, durationSec } = protection;
  if (durationSec <= 0 || startBps <= baseFeeBps || elapsed >= durationSec) {
    return baseFeeBps;
  }
  const extra = startBps - baseFeeBps;
  return baseFeeBps + Math.floor((extra * (durationSec - elapsed)) / durationSec);
}

/** Seconds of launch protection left, as a float for smooth countdown rings. */
export function protectionRemainingSec(
  launchedAtMs: number,
  nowMs: number,
  protection: LaunchProtection,
): number {
  const remaining = protection.durationSec - (nowMs - launchedAtMs) / 1000;
  return Math.max(0, Math.min(protection.durationSec, remaining));
}

export function isProtectionActive(
  launchedAtMs: number,
  nowMs: number,
  protection: LaunchProtection,
): boolean {
  return protectionRemainingSec(launchedAtMs, nowMs, protection) > 0;
}

export function bpsToPercent(bps: number): number {
  return (bps / BPS) * 100;
}
