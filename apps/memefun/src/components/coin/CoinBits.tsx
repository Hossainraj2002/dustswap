"use client";

import NumberFlow from "@number-flow/react";
import { ShieldAlert } from "lucide-react";
import { formatSmallNumber, spokenSmallNumber } from "@/core/format";
import { cn } from "@/lib/cn";
import type { Coin } from "@/lib/market/types";
import { Badge } from "@/components/ui/display";

/** Animated compact USD value, e.g. market cap. */
export function UsdFlow({ value, className, compact = true }: { value: number; className?: string; compact?: boolean }) {
  return (
    <NumberFlow
      value={Number.isFinite(value) ? value : 0}
      className={cn("mf-num", className)}
      format={
        compact
          ? { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: value >= 1_000_000 ? 2 : 1 }
          : { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }
      }
    />
  );
}

/** Tiny prices with subscript zeros; screen readers get a plain reading. */
export function PriceText({ usd, className }: { usd: number; className?: string }) {
  return (
    <span className={cn("mf-num", className)}>
      <span className="sr-only">{spokenSmallNumber(usd)} dollars</span>
      <span aria-hidden>${formatSmallNumber(usd)}</span>
    </span>
  );
}

export function PairBadge({ coin }: { coin: Coin }) {
  return (
    <Badge tone={coin.quote.kind === "stock" ? "tint" : "gray"}>
      {coin.quote.symbol}
    </Badge>
  );
}

export function ProtectionBadge() {
  return (
    <Badge tone="warning" icon={<ShieldAlert aria-hidden />}>
      Launch protection
    </Badge>
  );
}
