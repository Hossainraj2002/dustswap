import { protectionRemainingSec } from "@/core/antiSnipe";
import { milestoneProgress } from "@/core/milestones";
import type { Coin } from "@/lib/market/types";
import type { AvatarRing } from "@/components/ui/CoinAvatar";

/** Launch protection while it lasts, then progress to the next milestone. */
export function coinRing(coin: Coin, now: number): AvatarRing {
  if (now > 0) {
    const protection = { startBps: coin.terms.snipeStartBps, durationSec: coin.terms.snipeDurationSec };
    const remaining = protectionRemainingSec(coin.createdAt, now, protection);
    if (remaining > 0 && protection.durationSec > 0) {
      return { kind: "protection", remaining: remaining / protection.durationSec };
    }
  }
  return { kind: "milestone", progress: milestoneProgress(coin.marketCapUsd, coin.openingMarketCapUsd).progress };
}

export function inProtection(coin: Coin, now: number): boolean {
  return now > 0 && now - coin.createdAt < coin.terms.snipeDurationSec * 1000;
}
