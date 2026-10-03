"use client";

import Link from "next/link";
import { formatCoinAmount, formatQuoteAmount, shortAddress } from "@/core/format";
import { milestoneLabel } from "@/core/milestones";
import { useActivity, useCoins } from "@/lib/market/hooks";
import type { ActivityItem, Coin } from "@/lib/market/types";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { Marquee } from "@/components/ui/Marquee";
import { Skeleton } from "@/components/ui/display";

const dot: Record<string, string> = {
  buy: "bg-up",
  sell: "bg-down",
  launch: "bg-tint",
  burn: "bg-mode-burn",
  payout: "bg-mode-holders",
  floor: "bg-mode-floor",
  milestone: "bg-warning-ring",
};

function describe(item: ActivityItem, coin: Coin): { tone: string; text: string } {
  switch (item.kind) {
    case "trade": {
      const trade = item.trade;
      if (!trade) return { tone: "buy", text: "" };
      return {
        tone: trade.side,
        text: `${shortAddress(trade.trader)} ${trade.side === "buy" ? "bought" : "sold"} ${formatQuoteAmount(trade.quoteAmount, coin.quote.symbol)}`,
      };
    }
    case "launch":
      return { tone: "launch", text: "just launched" };
    case "burn":
      return { tone: "burn", text: `burned ${formatCoinAmount(item.amountCoins ?? 0)}` };
    case "payout":
      return { tone: "payout", text: `paid holders ${formatQuoteAmount(item.amountQuote ?? 0, coin.quote.symbol)}` };
    case "floor":
      return { tone: "floor", text: `floor at ${formatQuoteAmount(item.amountQuote ?? 0, coin.quote.symbol)}` };
    case "milestone":
      return { tone: "milestone", text: `passed ${milestoneLabel(item.milestone ?? 0)}` };
  }
}

/** Live ticker of launches, trades, burns, payouts and milestones. */
export function LiveTape() {
  const activity = useActivity(24);
  const { coins, ready } = useCoins();
  if (!ready) return <Skeleton className="h-10 w-full rounded-full" />;
  const byAddress = new Map(coins.map((coin) => [coin.address, coin]));
  const items = activity.filter((item) => byAddress.has(item.coin)).slice(0, 18);
  if (items.length === 0) return null;
  return (
    <Marquee label="Live activity" durationSec={Math.max(30, items.length * 4)}>
      {items.map((item) => {
        const coin = byAddress.get(item.coin) as Coin;
        const { tone, text } = describe(item, coin);
        return (
          <Link
            key={item.id}
            href={`/t/${coin.address}`}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-bg-elevated px-3 text-footnote text-label shadow-card transition-colors hover:bg-fill-4"
          >
            <span className={`size-2 rounded-full ${dot[tone] ?? "bg-label-3"}`} aria-hidden />
            <CoinAvatar src={coin.image} alt="" size={22} symbol={coin.symbol} />
            <span className="font-semibold">${coin.symbol}</span>
            <span className="text-label-2">{text}</span>
          </Link>
        );
      })}
    </Marquee>
  );
}
