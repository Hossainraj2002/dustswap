"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LayoutGrid, Megaphone, Rows3, Sparkles } from "lucide-react";
import type { FeeMode } from "@/core/types";
import { useIsRegularWidth, useLocalStorageState } from "@/lib/hooks";
import { useCoins, useModeration } from "@/lib/market/hooks";
import type { Coin } from "@/lib/market/types";
import { usePreview } from "@/lib/preview/scenario";
import { PageHeader } from "@/components/shell/PageHeader";
import { CoinCard } from "@/components/coin/CoinCard";
import { CoinRow } from "@/components/coin/CoinRow";
import { CoinTable } from "@/components/coin/CoinTable";
import { Button } from "@/components/ui/Button";
import { Chip, EmptyState, Skeleton } from "@/components/ui/display";
import { IconButton } from "@/components/ui/IconButton";
import { MODE_META } from "@/components/ui/ModeBadge";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { JustLaunched } from "./JustLaunched";
import { LiveTape } from "./LiveTape";
import { Spotlight } from "./Spotlight";
import { TopCreators } from "./TopCreators";

type Sort = "trending" | "new" | "top" | "movers";
type PairFilter = "all" | "eth" | "usdc" | "stocks";

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "trending", label: "Trending" },
  { value: "new", label: "New" },
  { value: "top", label: "Top" },
  { value: "movers", label: "Movers" },
];

const PAGE = 24;

function sortCoins(coins: Coin[], sort: Sort): Coin[] {
  const list = [...coins];
  switch (sort) {
    case "trending":
      return list.sort((a, b) => b.momentum - a.momentum);
    case "new":
      return list.sort((a, b) => b.createdAt - a.createdAt);
    case "top":
      return list.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    case "movers":
      return list.sort((a, b) => b.change1h - a.change1h);
  }
}

export function DiscoverScreen() {
  const { coins, ready } = useCoins();
  const moderation = useModeration();
  const { stocksRestricted } = usePreview();
  const regular = useIsRegularWidth();
  const searchParams = useSearchParams();
  const [sort, setSort] = useState<Sort>("trending");
  const [pair, setPair] = useState<PairFilter>("all");
  const [mode, setMode] = useState<FeeMode | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [view, setView] = useLocalStorageState<"grid" | "table">("memefun:discover-view", "grid");

  useEffect(() => {
    const requested = searchParams.get("sort");
    if (requested === "new" || requested === "top" || requested === "movers" || requested === "trending") setSort(requested);
  }, [searchParams]);

  useEffect(() => setLimit(PAGE), [sort, pair, mode]);

  const visible = useMemo(() => {
    const filtered = coins.filter((coin) => {
      if (stocksRestricted && coin.quote.kind === "stock") return false;
      if (pair === "eth" && coin.quote.symbol !== "ETH") return false;
      if (pair === "usdc" && coin.quote.symbol !== "USDC") return false;
      if (pair === "stocks" && coin.quote.kind !== "stock") return false;
      if (mode && coin.terms.mode !== mode) return false;
      return true;
    });
    return sortCoins(filtered, sort);
  }, [coins, mode, pair, sort, stocksRestricted]);

  const king = useMemo(() => [...coins].filter((coin) => !(stocksRestricted && coin.quote.kind === "stock")).sort((a, b) => b.momentum - a.momentum)[0], [coins, stocksRestricted]);
  const newest = useMemo(() => [...coins].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5), [coins]);

  const header = (
    <PageHeader
      title="Discover"
      subtitle="Coins launched on Base, trading live."
      actions={
        regular ? (
          <IconButton
            label={view === "grid" ? "Show as table" : "Show as grid"}
            icon={view === "grid" ? <Rows3 aria-hidden /> : <LayoutGrid aria-hidden />}
            onClick={() => setView(view === "grid" ? "table" : "grid")}
          />
        ) : null
      }
    />
  );

  if (!ready) {
    return (
      <>
        {header}
        <DiscoverSkeleton />
      </>
    );
  }

  if (coins.length === 0) {
    return (
      <>
        {header}
        <div className="mf-card">
          <EmptyState
            icon={<Sparkles aria-hidden />}
            title="No coins yet"
            message="Be the first to launch on memefun. It takes one transaction and the liquidity is locked forever."
            action={
              <Button asChild size="lg">
                <Link href="/create">Create the first coin</Link>
              </Button>
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        {moderation.banner ? (
          <p role="status" className="flex items-start gap-3 rounded-lg bg-tint/10 p-4 text-subhead text-label">
            <Megaphone className="mt-0.5 size-5 shrink-0 text-tint" aria-hidden />
            {moderation.banner}
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          {king ? <Spotlight coin={king} /> : null}
          <JustLaunched coins={newest} />
        </div>

        <LiveTape />

        <section aria-label="Coins" className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <SegmentedControl label="Sort coins" segments={SORTS} value={sort} onChange={setSort} fullWidth={!regular} className="lg:shrink-0" />
            <div className="mf-scroll-x -mx-4 flex gap-2 px-4 py-1.5 lg:mx-0 lg:min-w-0 lg:px-0" role="group" aria-label="Filter coins">
              {(
                [
                  ["all", "All pairs"],
                  ["eth", "ETH"],
                  ["usdc", "USDC"],
                  ...(stocksRestricted ? [] : [["stocks", "Stocks"]]),
                ] as Array<[PairFilter, string]>
              ).map(([value, label]) => (
                <Chip key={value} selected={pair === value} onClick={() => setPair(value)}>
                  {label}
                </Chip>
              ))}
              <span className="mx-1 w-px shrink-0 self-stretch bg-separator" aria-hidden />
              {(Object.keys(MODE_META) as FeeMode[]).map((key) => {
                const Icon = MODE_META[key].icon;
                return (
                  <Chip key={key} selected={mode === key} onClick={() => setMode(mode === key ? null : key)} icon={<Icon aria-hidden />}>
                    {MODE_META[key].short}
                  </Chip>
                );
              })}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="mf-card">
              <EmptyState title="No coins match these filters" message="Clear a filter to see more coins." action={<Button variant="gray" onClick={() => { setPair("all"); setMode(null); }}>Clear filters</Button>} />
            </div>
          ) : regular ? (
            view === "table" ? (
              <CoinTable coins={visible.slice(0, limit)} />
            ) : (
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4">
                {visible.slice(0, limit).map((coin) => (
                  <CoinCard key={coin.address} coin={coin} />
                ))}
              </div>
            )
          ) : (
            <div className="mf-card overflow-hidden [&>*+*]:hairline-t">
              {visible.slice(0, limit).map((coin, index) => (
                <CoinRow key={coin.address} coin={coin} rank={sort === "top" || sort === "trending" ? index + 1 : undefined} />
              ))}
            </div>
          )}

          {visible.length > limit ? (
            <div className="flex justify-center">
              <Button variant="gray" onClick={() => setLimit((current) => current + PAGE)}>
                Show more coins
              </Button>
            </div>
          ) : null}
        </section>

        <TopCreators />
      </div>
    </>
  );
}

function DiscoverSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading coins">
      <div className="mf-card flex flex-col gap-4 p-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-[88px] rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-48" />
          </div>
        </div>
        <Skeleton className="h-14 w-full" />
      </div>
      <Skeleton className="h-10 w-full rounded-full" />
      <div className="mf-card overflow-hidden [&>*+*]:hairline-t">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-12 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-7 w-[72px] rounded-[7px]" />
          </div>
        ))}
      </div>
    </div>
  );
}
