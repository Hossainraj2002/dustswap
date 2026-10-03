"use client";

import Link from "next/link";
import { formatAge } from "@/core/format";
import { useNow } from "@/lib/hooks";
import type { Coin } from "@/lib/market/types";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { ChangePill } from "@/components/ui/display";
import { Sparkline } from "@/components/ui/Sparkline";
import { UsdFlow } from "./CoinBits";
import { coinRing } from "./ring";

/** Apple Stocks style row: ticker and name, sparkline, value and change pill. */
export function CoinRow({ coin, rank }: { coin: Coin; rank?: number }) {
  const now = useNow();
  return (
    <Link
      href={`/t/${coin.address}`}
      className="flex min-h-[68px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-fill-4 active:bg-fill-3"
    >
      {rank !== undefined ? <span className="mf-num w-5 shrink-0 text-center text-footnote text-label-2">{rank}</span> : null}
      <CoinAvatar src={coin.image} alt="" size={48} ring={coinRing(coin, now)} symbol={coin.symbol} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-headline text-label">{coin.symbol}</span>
        <span className="truncate text-subhead text-label-2">
          {coin.name}
          {now > 0 ? <span aria-hidden> · {formatAge(now - coin.createdAt)}</span> : null}
        </span>
      </span>
      <Sparkline values={coin.sparkline} width={56} height={26} className="hidden shrink-0 min-[400px]:block" />
      <span className="flex w-[84px] shrink-0 flex-col items-end gap-1">
        <UsdFlow value={coin.marketCapUsd} className="text-subhead font-semibold text-label" />
        <span className="sr-only">1 hour change</span>
        <ChangePill value={coin.change1h} size="sm" />
      </span>
    </Link>
  );
}
