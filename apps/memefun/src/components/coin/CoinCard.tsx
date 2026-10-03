"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { formatAge, formatCompact, formatUsd } from "@/core/format";
import { useNow } from "@/lib/hooks";
import type { Coin } from "@/lib/market/types";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { ChangePill } from "@/components/ui/display";
import { ModeBadge } from "@/components/ui/ModeBadge";
import { Sparkline } from "@/components/ui/Sparkline";
import { PairBadge, ProtectionBadge, UsdFlow } from "./CoinBits";
import { coinRing, inProtection } from "./ring";

export function CoinCard({ coin }: { coin: Coin }) {
  const now = useNow();
  const protecting = inProtection(coin, now);
  return (
    <motion.article layout="position" className="mf-card group relative flex flex-col gap-3 p-4 transition-shadow hover:shadow-float">
      <div className="flex items-start gap-3">
        <CoinAvatar src={coin.image} alt="" size={56} ring={coinRing(coin, now)} symbol={coin.symbol} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-headline text-label">
            <Link href={`/t/${coin.address}`} className="after:absolute after:inset-0 after:rounded-lg after:content-['']">
              {coin.name}
            </Link>
          </h3>
          <p className="truncate text-subhead text-label-2">
            ${coin.symbol}
            {now > 0 ? ` · ${formatAge(now - coin.createdAt)}` : ""}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {protecting ? <ProtectionBadge /> : <ModeBadge mode={coin.terms.mode} compact />}
            <PairBadge coin={coin} />
          </div>
        </div>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-caption1 font-semibold uppercase tracking-wide text-label-2">Market cap</span>
          <UsdFlow value={coin.marketCapUsd} className="text-title2 font-bold text-label" />
        </div>
        <span className="flex items-center gap-1.5">
          <span className="text-caption1 font-semibold text-label-2">1h</span>
          <ChangePill value={coin.change1h} />
        </span>
      </div>
      <Sparkline values={coin.sparkline} width={280} height={40} area fluid />
      <dl className="grid grid-cols-3 gap-2 text-footnote">
        <div>
          <dt className="text-label-2">Vol 24h</dt>
          <dd className="mf-num font-semibold text-label">{formatUsd(coin.volume24hUsd, { compact: true })}</dd>
        </div>
        <div>
          <dt className="text-label-2">Holders</dt>
          <dd className="mf-num font-semibold text-label">{formatCompact(coin.holders)}</dd>
        </div>
        <div>
          <dt className="text-label-2">Fee</dt>
          <dd className="mf-num font-semibold text-label">{(coin.terms.feeBps / 100).toFixed(coin.terms.feeBps % 100 === 0 ? 0 : 2)}%</dd>
        </div>
      </dl>
    </motion.article>
  );
}
