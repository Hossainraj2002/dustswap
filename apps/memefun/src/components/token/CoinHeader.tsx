"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Share, Star } from "lucide-react";
import { launchFeeBps } from "@/core/antiSnipe";
import { formatCompact, formatUsd, shortAddress } from "@/core/format";
import { cn } from "@/lib/cn";
import { useLocalStorageState, useNow } from "@/lib/hooks";
import type { Coin } from "@/lib/market/types";
import { WalletButton } from "@/components/shell/WalletButton";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { CopyButton } from "@/components/ui/CopyButton";
import { ChangePill } from "@/components/ui/display";
import { IconButton } from "@/components/ui/IconButton";
import { ModeBadge } from "@/components/ui/ModeBadge";
import { PairBadge, PriceText, ProtectionBadge, UsdFlow } from "@/components/coin/CoinBits";
import { coinRing, inProtection } from "@/components/coin/ring";
import { TelegramLogo, XLogo } from "@/components/share/BrandIcons";

export function useWatchlist() {
  return useLocalStorageState<string[]>("memefun:watchlist", []);
}

export function CoinHeader({ coin, onShare }: { coin: Coin; onShare: () => void }) {
  const now = useNow();
  const feeBps = now > 0
    ? launchFeeBps(coin.terms.feeBps, { startBps: coin.terms.snipeStartBps, durationSec: coin.terms.snipeDurationSec }, (now - coin.createdAt) / 1000)
    : coin.terms.feeBps;
  const [watchlist, setWatchlist] = useWatchlist();
  const watched = watchlist.includes(coin.address);
  const sentinel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setCompact(entry ? !entry.isIntersecting : false));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const toggleWatch = () => setWatchlist(watched ? watchlist.filter((entry) => entry !== coin.address) : [...watchlist, coin.address]);

  return (
    <>
      <div
        aria-hidden={!compact}
        className={cn(
          "mf-material hairline-b fixed inset-x-0 top-0 z-30 flex items-center gap-2 px-2 transition-opacity duration-200 lg:hidden",
          compact ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        style={{ paddingTop: "var(--mf-safe-top)", height: "calc(52px + var(--mf-safe-top))" }}
      >
        <Link href="/" aria-label="Back to Discover" className="flex size-11 items-center justify-center text-tint">
          <ChevronLeft className="size-6" aria-hidden />
        </Link>
        <CoinAvatar src={coin.image} alt="" size={28} symbol={coin.symbol} />
        <span className="min-w-0 flex-1 truncate text-headline text-label">{coin.symbol}</span>
        <UsdFlow value={coin.marketCapUsd} className="text-subhead font-semibold text-label" />
        <ChangePill value={coin.change1h} size="sm" className="mr-1" />
      </div>

      <header className="flex flex-col gap-4 pb-2 pt-[max(12px,var(--mf-safe-top))] lg:pt-6">
        <div className="flex items-center justify-between gap-2">
          <Link href="/" className="-ml-2 inline-flex h-11 items-center gap-0.5 rounded-sm pr-2 text-body text-tint lg:hidden">
            <ChevronLeft className="size-6" aria-hidden />
            Discover
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <IconButton label={watched ? "Remove from watchlist" : "Add to watchlist"} icon={<Star className={cn(watched && "fill-current text-warning-ring")} aria-hidden />} onClick={toggleWatch} />
            <IconButton label={`Share ${coin.symbol}`} icon={<Share aria-hidden />} onClick={onShare} />
            <WalletButton />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <CoinAvatar src={coin.image} alt={`${coin.name} logo`} size={84} ring={coinRing(coin, now)} symbol={coin.symbol} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-title1 text-label">{coin.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="text-subhead font-semibold text-label-2">${coin.symbol}</span>
              {inProtection(coin, now) ? <ProtectionBadge /> : null}
              <ModeBadge mode={coin.terms.mode} compact feeBps={feeBps} />
              <PairBadge coin={coin} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-footnote text-label-2">
              <CopyButton value={coin.address} label="Copy contract address" className="-ml-2.5">
                <span className="mf-num">{shortAddress(coin.address, 4, 4)}</span>
              </CopyButton>
              {coin.links.x ? (
                <a href={`https://x.com/${coin.links.x}`} target="_blank" rel="noopener noreferrer" aria-label={`${coin.name} on X`} className="inline-flex size-8 items-center justify-center rounded-full hover:bg-fill-3">
                  <XLogo className="size-3.5" />
                </a>
              ) : null}
              {coin.links.telegram ? (
                <a href={`https://t.me/${coin.links.telegram}`} target="_blank" rel="noopener noreferrer" aria-label={`${coin.name} on Telegram`} className="inline-flex size-8 items-center justify-center rounded-full hover:bg-fill-3">
                  <TelegramLogo className="size-3.5" />
                </a>
              ) : null}
            </div>
          </div>
        </div>
        <div ref={sentinel} aria-hidden className="h-px" />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="col-span-2 sm:col-span-1 lg:col-span-2">
            <dt className="text-caption1 font-semibold uppercase tracking-wide text-label-2">Market cap</dt>
            <dd className="flex items-center gap-2">
              <UsdFlow value={coin.marketCapUsd} className="text-large-title font-bold leading-tight text-label" />
              <ChangePill value={coin.change1h} />
            </dd>
          </div>
          <Stat label="Price" value={<PriceText usd={coin.priceUsd} />} />
          <Stat label="Vol 24h" value={formatUsd(coin.volume24hUsd, { compact: true })} />
          <Stat label="Liquidity" value={formatUsd(coin.liquidityUsd, { compact: true })} />
          <Stat label="Holders" value={formatCompact(coin.holders)} />
        </dl>
      </header>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-end">
      <dt className="text-caption1 font-semibold uppercase tracking-wide text-label-2">{label}</dt>
      <dd className="mf-num text-headline text-label">{value}</dd>
    </div>
  );
}
