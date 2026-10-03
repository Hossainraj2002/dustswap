"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SearchX } from "lucide-react";
import { useCoin } from "@/lib/market/hooks";
import type { Coin } from "@/lib/market/types";
import { Button } from "@/components/ui/Button";
import { EmptyState, Skeleton } from "@/components/ui/display";
import { Sheet } from "@/components/ui/Sheet";
import { ShareSheet, type ShareMoment } from "@/components/share/ShareSheet";
import { ChartCard } from "./ChartCard";
import { CoinHeader } from "./CoinHeader";
import { CoinTabs } from "./CoinTabs";
import { CreatorCard, MilestoneCard, ModeImpactCard } from "./SideCards";
import { TradePanel } from "./TradePanel";

export function CoinScreen({ address }: { address: string }) {
  const { coin, ready } = useCoin(address);
  const [shareMoment, setShareMoment] = useState<ShareMoment | null>(null);
  const [tradeSide, setTradeSide] = useState<"buy" | "sell" | null>(null);

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

  return (
    <>
      <CoinHeader coin={coin} onShare={() => share()} />
      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_384px]">
        <div className="flex min-w-0 flex-col gap-6">
          <ChartCard coin={coin} />
          <div className="flex flex-col gap-4 lg:hidden">
            <MilestoneCard coin={coin} onShare={share} />
            <ModeImpactCard coin={coin} />
            <CreatorCard coin={coin} />
          </div>
          <CoinTabs coin={coin} />
        </div>
        <aside className="hidden flex-col gap-4 self-start lg:sticky lg:top-6 lg:flex" aria-label={`Trade ${coin.symbol}`}>
          <div className="mf-card p-4">
            <TradePanel coin={coin} />
          </div>
          <MilestoneCard coin={coin} onShare={share} />
          <ModeImpactCard coin={coin} />
          <CreatorCard coin={coin} />
        </aside>
      </div>

      <MobileTradeBar coin={coin} onTrade={setTradeSide} />
      <Sheet open={tradeSide !== null} onOpenChange={(open) => !open && setTradeSide(null)} title={`Trade ${coin.symbol}`}>
        {tradeSide ? <TradePanel coin={coin} initialSide={tradeSide} onDone={() => setTradeSide(null)} /> : null}
      </Sheet>
      {shareMoment ? <ShareSheet coin={coin} open onOpenChange={(open) => !open && setShareMoment(null)} moment={shareMoment} /> : null}
    </>
  );
}

function MobileTradeBar({ coin, onTrade }: { coin: Coin; onTrade: (side: "buy" | "sell") => void }) {
  return (
    <div className="fixed inset-x-3 z-40 lg:hidden" style={{ bottom: "max(12px, calc(var(--mf-safe-bottom) + 4px))" }}>
      <div className="mf-glass mf-glass-dense mx-auto flex max-w-md gap-2 rounded-full p-2">
        <Button variant="buy" size="md" fullWidth className="rounded-full" onClick={() => onTrade("buy")}>
          Buy {coin.symbol}
        </Button>
        <Button variant="sell" size="md" fullWidth className="rounded-full" onClick={() => onTrade("sell")}>
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
