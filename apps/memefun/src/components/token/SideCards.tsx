"use client";

import Link from "next/link";
import { ChevronRight, Share } from "lucide-react";
import { COIN_SUPPLY_HUMAN } from "@/core/constants";
import { formatCoinAmount, formatCountdown, formatPercent, formatQuoteAmount, formatUsd, shortAddress } from "@/core/format";
import { milestoneLabel, milestoneProgress } from "@/core/milestones";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/hooks";
import { useActivity, useCoinBalance, useCreatorProfile } from "@/lib/market/hooks";
import type { Coin } from "@/lib/market/types";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { AddressAvatar } from "@/components/ui/AddressAvatar";
import { Button } from "@/components/ui/Button";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { Badge, ProgressBar } from "@/components/ui/display";
import { FeeSplitBar } from "@/components/ui/FeeSplitBar";
import { MODE_META } from "@/components/ui/ModeBadge";
import { coinRing } from "@/components/coin/ring";

const BUYBACK_THRESHOLD_USD = 25;

export function MilestoneCard({ coin, onShare }: { coin: Coin; onShare: (milestone?: number) => void }) {
  const now = useNow();
  const activity = useActivity(80);
  const progress = milestoneProgress(coin.marketCapUsd, coin.openingMarketCapUsd);
  const recent = activity.find((item) => item.kind === "milestone" && item.coin === coin.address && now - item.ts < 15 * 60_000);

  return (
    <section aria-labelledby={`milestone-${coin.address}`} className="mf-card flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <CoinAvatar src={coin.image} alt="" size={52} ring={coinRing(coin, now)} symbol={coin.symbol} />
        <div className="min-w-0 flex-1">
          <h2 id={`milestone-${coin.address}`} className="text-headline text-label">
            {progress.next ? `Next ring: ${milestoneLabel(progress.next)}` : "Every ring closed"}
          </h2>
          <p className="mf-num text-footnote text-label-2">
            {progress.next
              ? `${formatUsd(coin.marketCapUsd, { compact: true })} of ${milestoneLabel(progress.next)}, ${Math.round(progress.progress * 100)}%`
              : `${formatUsd(coin.marketCapUsd, { compact: true })} market cap`}
          </p>
        </div>
      </div>
      <ProgressBar value={progress.progress} label={`Progress to the next market cap milestone`} />
      {recent?.milestone ? (
        <div className="flex items-center justify-between gap-3 rounded-md bg-tint/10 px-3 py-2">
          <p className="text-footnote font-semibold text-tint">Just passed {milestoneLabel(recent.milestone)}</p>
          <Button size="sm" variant="tinted" leading={<Share className="size-4" aria-hidden />} onClick={() => onShare(recent.milestone)}>
            Share
          </Button>
        </div>
      ) : (
        <p className="text-footnote text-label-2">
          {progress.reached === 0 ? "No rings closed yet." : `${progress.reached} ${progress.reached === 1 ? "ring" : "rings"} closed.`} All-time high {formatUsd(coin.athMarketCapUsd, { compact: true })}.
        </p>
      )}
    </section>
  );
}

export function ModeImpactCard({ coin }: { coin: Coin }) {
  const now = useNow();
  const wallet = useWallet();
  const held = useCoinBalance(wallet.address, coin.address);
  const meta = MODE_META[coin.terms.mode];
  const Icon = meta.icon;
  const { stats, quote } = coin;
  const symbol = quote.symbol;
  const circulating = Math.max(1, coin.circulating);

  let body: React.ReactNode;
  switch (coin.terms.mode) {
    case "creator":
      body = (
        <Metric label="Creator has earned" value={formatQuoteAmount(stats.creatorEarnedQuote, symbol)} sub={formatUsd(stats.creatorEarnedQuote * quote.usdPrice)} />
      );
      break;
    case "burn": {
      const budgetUsd = stats.burnBudgetQuote * quote.usdPrice;
      body = (
        <>
          <Metric label="Burned so far" value={`${formatCoinAmount(stats.burnedCoins)} ${coin.symbol}`} sub={`${formatPercent(stats.burnedCoins / COIN_SUPPLY_HUMAN)} of supply, ${stats.buybacks} buybacks`} />
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-footnote text-label-2">
              <span>Next buyback</span>
              <span className="mf-num">{formatQuoteAmount(stats.burnBudgetQuote, symbol)} saved</span>
            </div>
            <ProgressBar value={budgetUsd / BUYBACK_THRESHOLD_USD} label="Saved toward the next buyback" tone="warning" />
          </div>
        </>
      );
      break;
    }
    case "holders": {
      const share = held > 0 ? stats.epochPendingQuote * (held / circulating) : 0;
      body = (
        <>
          <Metric label="Paid to holders" value={formatQuoteAmount(stats.holdersPaidQuote, symbol)} sub={`${formatUsd(stats.holdersPaidQuote * quote.usdPrice)} over ${stats.epochs} payouts`} />
          <div className="grid grid-cols-2 gap-3">
            <Metric small label="Next payout in" value={now > 0 ? formatCountdown(Math.max(0, stats.nextEpochAt - now)) : "0:00"} />
            <Metric small label="This payout so far" value={formatQuoteAmount(stats.epochPendingQuote, symbol)} />
          </div>
          {held > 0 ? (
            <p className="rounded-md bg-mode-holders/10 px-3 py-2 text-footnote text-label">
              Your share of this payout, if you keep holding: <span className="mf-num font-semibold">{formatQuoteAmount(share, symbol)}</span>
            </p>
          ) : null}
        </>
      );
      break;
    }
    case "floor": {
      const below = coin.priceUsd > 0 ? 1 - stats.floorPriceUsd / coin.priceUsd : 0;
      body = (
        <>
          <Metric label="Floor liquidity" value={formatQuoteAmount(stats.floorQuote, symbol)} sub={formatUsd(stats.floorQuote * quote.usdPrice)} />
          <Metric
            small
            label="Price the floor can hold"
            value={formatUsd(stats.floorPriceUsd * COIN_SUPPLY_HUMAN, { compact: true }) + " market cap"}
            sub={stats.floorPriceUsd > 0 ? `${formatPercent(below)} under the current price` : "Grows with every trade"}
          />
        </>
      );
      break;
    }
  }

  return (
    <section aria-labelledby={`mode-${coin.address}`} className="mf-card flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${meta.color} 14%, transparent)`, color: meta.color }}>
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id={`mode-${coin.address}`} className="text-headline text-label">
            {meta.label}
          </h2>
          <p className="text-footnote text-label-2">{meta.description}</p>
        </div>
      </div>
      {body}
      <FeeSplitBar
        config={{ mode: coin.terms.mode, platformShareBps: coin.terms.platformShareBps, referralShareBps: coin.terms.referralShareBps, creatorKeepBps: coin.terms.creatorKeepBps }}
        feeBps={coin.terms.feeBps}
      />
    </section>
  );
}

function Metric({ label, value, sub, small }: { label: string; value: string; sub?: string; small?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-footnote text-label-2">{label}</span>
      <span className={cn("mf-num font-bold text-label", small ? "text-headline" : "text-title2")}>{value}</span>
      {sub ? <span className="mf-num text-footnote text-label-2">{sub}</span> : null}
    </div>
  );
}

export function CreatorCard({ coin }: { coin: Coin }) {
  const profile = useCreatorProfile(coin.creator);
  const wallet = useWallet();
  const isYou = wallet.address === coin.creator;
  return (
    <section aria-label="Creator" className="mf-card p-1">
      <Link href={`/u/${coin.creator}`} className="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-fill-4">
        <AddressAvatar address={coin.creator} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-headline text-label">{isYou ? "You" : profile?.name || shortAddress(coin.creator)}</p>
          <p className="text-footnote text-label-2">
            Creator of {profile?.coins.length ?? 1} {profile && profile.coins.length === 1 ? "coin" : "coins"}, earned {formatUsd(profile?.earnedUsd ?? 0, { compact: true })}
          </p>
          <div className="mt-1.5">
            {coin.devSold ? <Badge tone="warning">Creator has sold</Badge> : <Badge tone="up">Creator has not sold</Badge>}
          </div>
        </div>
        <ChevronRight className="size-4 text-label-3" aria-hidden />
      </Link>
    </section>
  );
}
