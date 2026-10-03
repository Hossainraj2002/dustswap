"use client";

import Link from "next/link";
import { Crown } from "lucide-react";
import { formatCompact, formatUsd } from "@/core/format";
import { milestoneLabel, milestoneProgress } from "@/core/milestones";
import { useNow } from "@/lib/hooks";
import type { Coin } from "@/lib/market/types";
import { Button } from "@/components/ui/Button";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { ChangePill } from "@/components/ui/display";
import { ModeBadge } from "@/components/ui/ModeBadge";
import { Sparkline } from "@/components/ui/Sparkline";
import { PairBadge, UsdFlow } from "@/components/coin/CoinBits";
import { coinRing } from "@/components/coin/ring";

/** King of the hill: the coin with the most momentum right now. */
export function Spotlight({ coin }: { coin: Coin }) {
  const now = useNow();
  const milestone = milestoneProgress(coin.marketCapUsd, coin.openingMarketCapUsd);
  return (
    <section aria-labelledby="spotlight-title" className="mf-card flex min-w-0 flex-col gap-5 p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <CoinAvatar src={coin.image} alt="" size={88} ring={coinRing(coin, now)} symbol={coin.symbol} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-footnote font-semibold uppercase tracking-wide text-warning">
              <Crown className="size-4" aria-hidden />
              King of the hill
            </p>
            <h2 id="spotlight-title" className="truncate text-title1 text-label">
              {coin.name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="text-subhead text-label-2">${coin.symbol}</span>
              <ModeBadge mode={coin.terms.mode} compact />
              <PairBadge coin={coin} />
            </div>
          </div>
        </div>
        <div className="flex items-end justify-between gap-4 sm:flex-col sm:items-end">
          <div className="flex flex-col sm:items-end">
            <span className="text-caption1 font-semibold uppercase tracking-wide text-label-2">Market cap</span>
            <UsdFlow value={coin.marketCapUsd} className="text-large-title font-bold leading-none text-label" />
            {milestone.next ? (
              <span className="mt-1 text-footnote text-label-2">
                {Math.round(milestone.progress * 100)}% of the way to {milestoneLabel(milestone.next)}
              </span>
            ) : null}
          </div>
          <span className="flex items-center gap-1.5">
            <span className="text-caption1 font-semibold text-label-2">1h</span>
            <ChangePill value={coin.change1h} />
          </span>
        </div>
      </div>
      <div className="min-h-[72px] min-w-0 flex-1">
        <Sparkline values={coin.sparkline} width={640} height={120} area fluid className="h-full min-h-[72px]" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <dl className="flex gap-5 text-footnote">
          <div>
            <dt className="text-label-2">Vol 24h</dt>
            <dd className="mf-num text-subhead font-semibold text-label">{formatUsd(coin.volume24hUsd, { compact: true })}</dd>
          </div>
          <div>
            <dt className="text-label-2">Holders</dt>
            <dd className="mf-num text-subhead font-semibold text-label">{formatCompact(coin.holders)}</dd>
          </div>
          <div>
            <dt className="text-label-2">Liquidity</dt>
            <dd className="mf-num text-subhead font-semibold text-label">{formatUsd(coin.liquidityUsd, { compact: true })}</dd>
          </div>
        </dl>
        <Button asChild size="md">
          <Link href={`/t/${coin.address}`}>Trade {coin.symbol}</Link>
        </Button>
      </div>
    </section>
  );
}
