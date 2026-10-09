"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SearchX } from "lucide-react";
import { useCoin } from "@/lib/market/hooks";
import { usePlatformToken } from "@/lib/platform-token/usePlatformToken";
import type { Coin } from "@/lib/market/types";
import type { Hash } from "@/core/types";
import { selectCoinMarket } from "@/lib/market/markets";
import { Button } from "@/components/ui/Button";
import { EmptyState, Skeleton } from "@/components/ui/display";
import { Sheet } from "@/components/ui/Sheet";
import { ShareSheet, type ShareMoment } from "@/components/share/ShareSheet";
import { ChartCard } from "./ChartCard";
import { CoinHeader } from "./CoinHeader";
import { CoinTabs } from "./CoinTabs";
import { CreatorCard, MilestoneCard, ModeImpactCard } from "./SideCards";
import { TradePanel } from "./TradePanel";
import { CreatorControls } from "./CreatorControls";
import { AuthorRewardCard } from "@/components/rewards/AuthorRewardsScreen";

export function CoinScreen({ address }: { address: string }) {
  const { coin, ready } = useCoin(address);
  const platform = usePlatformToken();
  const official = platform.showAnnouncement && platform.available && platform.info?.enabled === true && platform.info.tokenAddress?.toLowerCase() === coin?.address.toLowerCase();
  const [shareMoment, setShareMoment] = useState<ShareMoment | null>(null);
  const [tradeSide, setTradeSide] = useState<"buy" | "sell" | null>(null);
  const [poolId, setPoolId] = useState<Hash>();
  const [tradePending, setTradePending] = useState(false);

  // Every page needs a descriptive title (WCAG 2.4.2); it names the coin, not the market cap, so it stays stable.
  const title = !ready ? null : coin ? `${coin.name} ($${coin.symbol}) | memefun` : "Coin not found | memefun";
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  if (!ready) return <CoinSkeleton />;
  if (!coin) {
    return (
      <div className="pt-10">
        <div className="mf-card">
          <EmptyState
            icon={<SearchX aria-hidden />}
            title="Coin not found"
            message="Check the address, or find it by name in Discover."
            action={
              <Button asChild>
                <Link href="/">Go to Discover</Link>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const share = (milestone?: number) => setShareMoment(milestone ? { kind: "milestone", milestone } : { kind: "coin" });
  const activePoolId = coin.markets?.find((market) => market.poolId === poolId)?.poolId ?? coin.markets?.[0]?.poolId;
  const selectedCoin = selectCoinMarket(coin, activePoolId);

  return (
    <>
      <CoinHeader coin={coin} official={official} onShare={() => share()} />
      {coin.markets?.length ? <label className="mt-4 flex flex-wrap items-center gap-3 text-subhead text-label">Trading pool
        <select aria-label="Trading pool" disabled={tradePending} value={activePoolId} onChange={(event) => setPoolId(event.target.value as Hash)} className="rounded-md bg-fill-4 p-3 text-label">
          {coin.markets.map((market) => <option key={market.poolId} value={market.poolId}>{coin.symbol} / {market.quote.symbol}</option>)}
        </select><span className="text-footnote text-label-2">Chart, trades and earnings below use this pool. Header totals include every pool.</span>
      </label> : null}
      <CreatorControls coin={coin} />
      <AuthorRewardCard coin={coin} />
      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_384px]">
        <div className="flex min-w-0 flex-col gap-6">
          <ChartCard coin={selectedCoin} official={official} />
          <div className="flex flex-col gap-4 lg:hidden">
            <MilestoneCard coin={coin} onShare={share} />
            <ModeImpactCard coin={selectedCoin} />
            <CreatorCard coin={coin} official={official} />
          </div>
          <CoinTabs coin={selectedCoin} official={official} />
        </div>
        <aside className="hidden flex-col gap-4 self-start lg:sticky lg:top-6 lg:flex" aria-label={`Trade ${coin.symbol}`}>
          <div className="mf-card p-4">
            <TradePanel coin={selectedCoin} locked={tradePending} onPendingChange={setTradePending} />
          </div>
          <MilestoneCard coin={coin} onShare={share} />
          <ModeImpactCard coin={selectedCoin} />
          <CreatorCard coin={coin} official={official} />
        </aside>
      </div>

      <MobileTradeBar coin={selectedCoin} onTrade={setTradeSide} disabled={tradePending} />
      <Sheet open={tradeSide !== null} onOpenChange={(open) => !open && !tradePending && setTradeSide(null)} title={`Trade ${coin.symbol}`}>
        {tradeSide ? <TradePanel coin={selectedCoin} initialSide={tradeSide} locked={tradePending} onPendingChange={setTradePending} onDone={() => setTradeSide(null)} /> : null}
      </Sheet>
      {shareMoment ? <ShareSheet coin={coin} open onOpenChange={(open) => !open && setShareMoment(null)} moment={shareMoment} /> : null}
    </>
  );
}

function MobileTradeBar({ coin, onTrade, disabled }: { coin: Coin; onTrade: (side: "buy" | "sell") => void; disabled: boolean }) {
  return (
    <div className="fixed inset-x-3 z-40 lg:hidden" style={{ bottom: "max(12px, calc(var(--mf-safe-bottom) + 4px))" }}>
      <div className="mf-glass mf-glass-dense mx-auto flex max-w-md gap-2 rounded-full p-2">
        <Button variant="buy" size="md" fullWidth disabled={disabled} className="rounded-full" onClick={() => onTrade("buy")}>
          Buy {coin.symbol}
        </Button>
        <Button variant="sell" size="md" fullWidth disabled={disabled} className="rounded-full" onClick={() => onTrade("sell")}>
          Sell
        </Button>
      </div>
    </div>
  );
}

function CoinSkeleton() {
  return (
    <div className="flex flex-col gap-6 pt-16" aria-busy="true" aria-label="Loading coin">
      <div className="flex items-center gap-4">
        <Skeleton className="size-[84px] rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <Skeleton className="h-10 w-56" />
      <Skeleton className="h-[300px] w-full rounded-lg" />
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
