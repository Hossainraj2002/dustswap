"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { formatBps, formatQuoteAmount, formatUsd } from "@/core/format";
import type { LaunchSettings } from "@/core/settings";
import type { QuoteAsset } from "@/core/types";
import { normalizeTicker } from "@/core/validation";
import type { CreateDraft } from "@/lib/create/draft";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { MODE_META } from "@/components/ui/ModeBadge";

export function ReviewStep({ draft, quote, settings }: { draft: CreateDraft; quote: QuoteAsset; settings: LaunchSettings }) {
  const meta = MODE_META[draft.mode];
  const firstBuy = Number(draft.firstBuy) || 0;
  const rows: Array<[string, React.ReactNode]> = [
    ["Pair", `${normalizeTicker(draft.ticker)} / ${quote.symbol}`],
    ["Trading fee", `${formatBps(draft.feeBps)} of every trade`],
    ["Fees go to", draft.mode === "creator" ? "You" : `${meta.destinationLabel}, you keep ${formatBps(draft.creatorKeepBps)} of that share`],
    ["Platform share", `${formatBps(settings.platformShareBps)} of each fee`],
    ["Launch protection", `${formatBps(settings.snipeStartBps)} fee at launch, ${formatBps(draft.feeBps)} after ${settings.snipeDurationSec} seconds`],
    ["Opening market cap", formatUsd(settings.openingFdvUsd)],
    ["Your first buy", firstBuy > 0 ? formatQuoteAmount(firstBuy, quote.symbol) : "None"],
    ["Creation fee", settings.creationFeeEth > 0 ? formatQuoteAmount(settings.creationFeeEth, "ETH") : "Free"],
  ];
  const guarantees = [
    "1,000,000,000 coins, fixed forever",
    "No admin key: nobody can mint, pause or block transfers",
    "The whole supply goes into the pool, locked forever",
    "The fee can only go down, and its destination never changes",
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg bg-fill-4 flex items-center gap-4 p-4">
        <CoinAvatar src={draft.image ?? undefined} alt="" size={64} ring={{ kind: "milestone", progress: 0 }} symbol={draft.ticker} />
        <div className="min-w-0">
          <p className="truncate text-title3 text-label">{draft.name.trim()}</p>
          <p className="text-subhead text-label-2">${normalizeTicker(draft.ticker)}</p>
        </div>
      </div>
      <dl className="rounded-lg bg-fill-4 overflow-hidden [&>div+div]:hairline-t">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-3 text-subhead">
            <dt className="shrink-0 text-label-2">{label}</dt>
            <dd className="text-right text-label">{value}</dd>
          </div>
        ))}
      </dl>
      <ul className="rounded-lg bg-fill-4 flex flex-col gap-2.5 p-4" aria-label="Guarantees">
        {guarantees.map((text) => (
          <li key={text} className="flex gap-2.5 text-subhead text-label">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-up" aria-hidden />
            {text}
          </li>
        ))}
      </ul>
      <p className="flex gap-2.5 px-1 text-footnote text-label-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        Launching is permanent. The name, ticker, supply and fee destination can never be changed or deleted.
      </p>
    </div>
  );
}
