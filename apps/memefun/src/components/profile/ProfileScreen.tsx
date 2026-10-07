"use client";

import Link from "next/link";
import { tradeQuoteSymbol } from "@/lib/market/markets";
import { useMemo, useState } from "react";
import { Share, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { formatAge, formatCoinAmount, formatQuoteAmount, formatUsd, shortAddress } from "@/core/format";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/hooks";
import { useCoins, useCreatorProfile, usePositions, useTradesByTrader } from "@/lib/market/hooks";
import type { Coin } from "@/lib/market/types";
import { referralLink } from "@/lib/referrals";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { PageHeader } from "@/components/shell/PageHeader";
import { CoinRow } from "@/components/coin/CoinRow";
import { AddressAvatar } from "@/components/ui/AddressAvatar";
import { Button } from "@/components/ui/Button";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { CopyButton } from "@/components/ui/CopyButton";
import { Badge, EmptyState, Skeleton } from "@/components/ui/display";
import { IconButton } from "@/components/ui/IconButton";
import { Tabs } from "@/components/ui/Tabs";

type TabKey = "created" | "held" | "activity";

export function ProfileScreen({ address }: { address: string }) {
  const wallet = useWallet();
  const now = useNow();
  const profile = useCreatorProfile(address);
  const { coins, ready } = useCoins();
  const positions = usePositions(address as `0x${string}`);
  const trades = useTradesByTrader(address, 40);
  const [tab, setTab] = useState<TabKey>("created");
  const isYou = wallet.address?.toLowerCase() === address.toLowerCase();
  const byAddress = useMemo(() => new Map(coins.map((coin) => [coin.address, coin])), [coins]);
  const created = coins.filter((coin) => coin.creator.toLowerCase() === address.toLowerCase());
  const portfolioUsd = positions.reduce((sum, position) => sum + position.valueUsd, 0);
  const name = isYou ? "Your profile" : profile?.name || shortAddress(address);

  const shareProfile = async () => {
    const url = referralLink(`/u/${address}`, wallet.address);
    try {
      if (typeof navigator.share === "function") await navigator.share({ title: `${name} on memefun`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast.success("Profile link copied");
      }
    } catch {
      // Share sheet dismissed.
    }
  };

  return (
    <>
      <PageHeader title={isYou ? "Profile" : "Creator"} actions={<IconButton label="Share profile" icon={<Share aria-hidden />} onClick={() => void shareProfile()} />} />
      {isYou ? <div className="mb-4 flex flex-wrap gap-3"><Button asChild variant="tinted"><Link href="/create/tweet">Launch by tweet</Link></Button><Button asChild variant="gray"><Link href="/rewards/author">Post author earnings</Link></Button></div> : null}
      <section aria-label="Profile" className="mf-card mb-6 flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <AddressAvatar address={address} size={72} />
          <div className="min-w-0">
            <h2 className="truncate text-title2 text-label">{name}</h2>
            <div className="flex flex-wrap items-center gap-1">
              <CopyButton value={address} label="Copy address" className="-ml-2.5">
                <span className="mf-num">{shortAddress(address, 6, 4)}</span>
              </CopyButton>
              {created.length > 0 ? <Badge tone="tint">Creator</Badge> : null}
              {isYou && wallet.mode === "demo" ? <Badge tone="warning">Demo wallet</Badge> : null}
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-4 sm:min-w-[360px]">
          <Stat label="Coins created" value={String(created.length)} />
          <Stat label="Earned" value={formatUsd(profile?.earnedUsd ?? 0, { compact: true })} tone="up" />
          <Stat label={isYou ? "Holdings" : "Volume"} value={formatUsd(isYou ? portfolioUsd : (profile?.volumeUsd ?? 0), { compact: true })} />
        </dl>
      </section>

      <Tabs<TabKey>
        label="Profile sections"
        value={tab}
        onChange={setTab}
        items={[
          {
            value: "created",
            label: "Created",
            count: created.length,
            content: !ready ? (
              <div className="mf-card mt-3 p-4" aria-busy="true" aria-label="Loading created coins"><Skeleton className="h-32 w-full rounded-lg" /></div>
            ) : created.length === 0 ? (
              <EmptyState
                className="mf-card mt-3"
                icon={<Sparkles aria-hidden />}
                title={isYou ? "You have not launched a coin" : "No coins yet"}
                message={isYou ? "Launch one in a single transaction and earn on every trade." : undefined}
                action={
                  isYou ? (
                    <Button asChild>
                      <Link href="/create">Create a coin</Link>
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="mf-card mt-3 overflow-hidden [&>*+*]:hairline-t">
                {created.map((coin) => (
                  <CoinRow key={coin.address} coin={coin} />
                ))}
              </div>
            ),
          },
          {
            value: "held",
            label: "Held",
            count: positions.length,
            content:
              positions.length === 0 ? (
                <EmptyState className="mf-card mt-3" title="No coins held" message={isYou ? "Coins you buy show up here with their value and profit." : undefined} />
              ) : (
                <ol className="mf-card mt-3 overflow-hidden [&>li+li]:hairline-t" aria-label="Holdings">
                  {positions.map((position) => {
                    const coin = byAddress.get(position.coin);
                    if (!coin) return null;
                    return <PositionRow key={position.coin} coin={coin} balance={position.balance} valueUsd={position.valueUsd} pnlUsd={position.pnlUsd} costUsd={position.costBasisUsd} />;
                  })}
                </ol>
              ),
          },
          {
            value: "activity",
            label: "Activity",
            content:
              trades.length === 0 ? (
                <EmptyState className="mf-card mt-3" title="No trades yet" />
              ) : (
                <ol className="mf-card mt-3 overflow-hidden [&>li+li]:hairline-t" aria-label="Recent trades">
                  {trades.map((trade) => {
                    const coin = byAddress.get(trade.coin);
                    if (!coin) return null;
                    return (
                      <li key={trade.id}>
                        <Link href={`/t/${coin.address}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-fill-4">
                          <CoinAvatar src={coin.image} alt="" size={36} symbol={coin.symbol} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-subhead text-label">
                              <span className={cn("font-semibold", trade.side === "buy" ? "text-up" : "text-down")}>{trade.side === "buy" ? "Bought" : "Sold"}</span>{" "}
                              {formatCoinAmount(trade.coinAmount)} {coin.symbol}
                            </span>
                            <span className="mf-num text-footnote text-label-2">{formatQuoteAmount(trade.quoteAmount, tradeQuoteSymbol(coin, trade))}</span>
                          </span>
                          <span className="mf-num text-footnote text-label-2">{now > 0 ? formatAge(now - trade.ts) : ""}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              ),
          },
        ]}
      />
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" }) {
  return (
    <div>
      <dt className="text-caption1 font-semibold uppercase tracking-wide text-label-2">{label}</dt>
      <dd className={cn("mf-num text-title3", tone === "up" ? "text-up" : "text-label")}>{value}</dd>
    </div>
  );
}

function PositionRow({ coin, balance, valueUsd, pnlUsd, costUsd }: { coin: Coin; balance: number; valueUsd: number; pnlUsd: number; costUsd: number }) {
  const pnlFraction = costUsd > 0 ? pnlUsd / costUsd : 0;
  return (
    <li>
      <Link href={`/t/${coin.address}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-fill-4">
        <CoinAvatar src={coin.image} alt="" size={40} symbol={coin.symbol} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-semibold text-label">{coin.symbol}</span>
          <span className="mf-num truncate text-footnote text-label-2">{formatCoinAmount(balance)} coins</span>
        </span>
        <span className="flex flex-col items-end">
          <span className="mf-num text-subhead font-semibold text-label">{formatUsd(valueUsd)}</span>
          <span className={cn("mf-num text-footnote font-semibold", pnlUsd >= 0 ? "text-up" : "text-down")}>
            {pnlUsd >= 0 ? "+" : "-"}
            {formatUsd(Math.abs(pnlUsd))} ({pnlUsd >= 0 ? "+" : "-"}
            {Math.abs(pnlFraction * 100).toFixed(1)}%)
          </span>
        </span>
      </Link>
    </li>
  );
}
