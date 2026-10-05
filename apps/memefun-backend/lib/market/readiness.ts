import type { LaunchSettings } from "../../shared/core/settings";
import type { QuoteAsset } from "../../shared/core/types";
import { type QuoteRecord, toQuoteAsset } from "./derive";

/** Index timestamps are seconds; HTTP eligibility timestamps are milliseconds. */
export function quoteEligibility(q: QuoteRecord, settings: LaunchSettings, nowSec: number) {
  if (!Number.isInteger(q.kind) || q.kind < 0 || q.kind > 3 || ![0, 1, 2].includes(q.source ?? -1)) {
    return { launchable: false, unavailableReason: "The pair's launch configuration could not be verified." };
  }
  if (q.enabled !== true) return { launchable: false, unavailableReason: "This pair is not enabled for new launches." };
  if (!settings.enabledQuoteKinds.includes(toQuoteAsset(q).kind)) return { launchable: false, unavailableReason: "This pair category is not enabled for new launches." };
  if (q.priceUsdE8 <= 0n) return { launchable: false, unavailableReason: "A verified launch price is not available." };
  if (q.source !== 0 && (!q.priceUpdatedAt || !q.maxAge || q.priceUpdatedAt > nowSec || nowSec - q.priceUpdatedAt > q.maxAge)) {
    return { launchable: false, unavailableReason: "The launch price is stale. Wait for a verified price update." };
  }
  if (settings.launchesPaused) return { launchable: false, unavailableReason: "New launches are paused." };
  return { launchable: true };
}

/** Frozen rounds keep their original updatedAt; an incomplete or future round is unusable. */
export function readableFeedRound(round: readonly [bigint, bigint, bigint, bigint, bigint], nowSec: number) {
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  return answer > 0n && updatedAt > 0n && updatedAt <= BigInt(nowSec) && answeredInRound >= roundId
    ? { priceUsdE8: answer, updatedAt: Number(updatedAt) } : null;
}

export function eligibleQuoteAsset(q: QuoteRecord, settings: LaunchSettings, nowSec: number): QuoteAsset & ReturnType<typeof quoteEligibility> {
  return { ...toQuoteAsset(q), ...quoteEligibility(q, settings, nowSec), enabled: q.enabled === true,
    priceUpdatedAt: (q.priceUpdatedAt ?? 0) * 1000, priceMaxAgeSec: q.maxAge ?? 0 };
}
