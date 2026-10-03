"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { formatAge, formatCompact, formatUsd } from "@/core/format";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/hooks";
import type { Coin } from "@/lib/market/types";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { ChangeText } from "@/components/ui/display";
import { MODE_META } from "@/components/ui/ModeBadge";
import { PriceText } from "./CoinBits";
import { coinRing } from "./ring";

type SortKey = "price" | "change5m" | "change1h" | "change24h" | "marketCap" | "volume" | "holders" | "age";

const columns: Array<{ key: SortKey; label: string; className?: string }> = [
  { key: "price", label: "Price" },
  { key: "change5m", label: "5m" },
  { key: "change1h", label: "1h" },
  { key: "change24h", label: "24h" },
  { key: "marketCap", label: "Market cap" },
  { key: "volume", label: "Vol 24h" },
  { key: "holders", label: "Holders" },
  { key: "age", label: "Age" },
];

function value(coin: Coin, key: SortKey): number {
  switch (key) {
    case "price":
      return coin.priceUsd;
    case "change5m":
      return coin.change5m;
    case "change1h":
      return coin.change1h;
    case "change24h":
      return coin.change24h;
    case "marketCap":
      return coin.marketCapUsd;
    case "volume":
      return coin.volume24hUsd;
    case "holders":
      return coin.holders;
    case "age":
      return -coin.createdAt;
  }
}

/** Desktop table with click-to-sort headers (HIG: sortable columns on wide layouts). */
export function CoinTable({ coins }: { coins: Coin[] }) {
  const now = useNow();
  const [sort, setSort] = useState<{ key: SortKey | null; desc: boolean }>({ key: null, desc: true });
  const rows = sort.key ? [...coins].sort((a, b) => (sort.desc ? -1 : 1) * (value(a, sort.key as SortKey) - value(b, sort.key as SortKey))) : coins;

  return (
    <div className="mf-card overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-subhead">
        <caption className="sr-only">Coins</caption>
        <thead>
          <tr className="hairline-b text-left text-footnote text-label-2">
            <th scope="col" className="px-4 py-3 font-semibold">
              Coin
            </th>
            {columns.map((column) => {
              const active = sort.key === column.key;
              return (
                <th key={column.key} scope="col" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className="px-3 py-3 text-right font-semibold">
                  <button
                    type="button"
                    onClick={() => setSort((current) => ({ key: column.key, desc: current.key === column.key ? !current.desc : true }))}
                    className={cn("inline-flex items-center gap-0.5 rounded-xs px-1 py-1 transition-colors hover:text-label", active && "text-label")}
                  >
                    {column.label}
                    {active ? sort.desc ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronUp className="size-3.5" aria-hidden /> : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="[&>tr+tr]:hairline-t">
          {rows.map((coin) => {
            const Mode = MODE_META[coin.terms.mode].icon;
            return (
              <tr key={coin.address} className="group transition-colors hover:bg-fill-4">
                <td className="px-4 py-2.5">
                  <Link href={`/t/${coin.address}`} className="flex items-center gap-3">
                    <CoinAvatar src={coin.image} alt="" size={40} ring={coinRing(coin, now)} symbol={coin.symbol} />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 truncate font-semibold text-label">
                        {coin.name}
                        <Mode className="size-3.5 shrink-0" style={{ color: MODE_META[coin.terms.mode].color }} aria-label={MODE_META[coin.terms.mode].label} />
                      </span>
                      <span className="text-footnote text-label-2">
                        ${coin.symbol} · {coin.quote.symbol}
                      </span>
                    </span>
                  </Link>
                </td>
                <td className="px-3 text-right">
                  <PriceText usd={coin.priceUsd} className="text-label" />
                </td>
                <td className="px-3 text-right">
                  <ChangeText value={coin.change5m} />
                </td>
                <td className="px-3 text-right">
                  <ChangeText value={coin.change1h} />
                </td>
                <td className="px-3 text-right">
                  <ChangeText value={coin.change24h} />
                </td>
                <td className="mf-num px-3 text-right font-semibold text-label">{formatUsd(coin.marketCapUsd, { compact: true })}</td>
                <td className="mf-num px-3 text-right text-label">{formatUsd(coin.volume24hUsd, { compact: true })}</td>
                <td className="mf-num px-3 text-right text-label">{formatCompact(coin.holders)}</td>
                <td className="mf-num px-3 pr-4 text-right text-label-2">{now > 0 ? formatAge(now - coin.createdAt) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
