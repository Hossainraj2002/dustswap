"use client";

import { formatBps, formatPercent, formatUsd } from "@/core/format";
import { normalizeTicker } from "@/core/validation";
import { selectedQuoteSymbols, type CreateDraft } from "@/lib/create/draft";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { Badge } from "@/components/ui/display";
import { ModeBadge } from "@/components/ui/ModeBadge";

/** How the coin will look in the feed, updated as the creator types. */
export function PreviewCard({ draft, openingFdvUsd }: { draft: CreateDraft; openingFdvUsd: number }) {
  const ticker = normalizeTicker(draft.ticker);
  return (
    <section aria-label="Preview of your coin" className="mf-card flex flex-col gap-4 p-5">
      <p className="text-footnote font-semibold uppercase tracking-wide text-label-2">Preview</p>
      <div className="flex items-center gap-4">
        <CoinAvatar src={draft.image ?? undefined} alt="" size={72} ring={{ kind: "milestone", progress: 0 }} symbol={ticker || "?"} />
        <div className="min-w-0">
          <p className="truncate text-title3 text-label">{draft.name.trim() || "Your coin"}</p>
          <p className="truncate text-subhead text-label-2">${ticker || "TICKER"}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <ModeBadge mode={draft.mode} compact />
            {selectedQuoteSymbols(draft).map((symbol) => <Badge key={symbol}>{symbol}</Badge>)}
          </div>
        </div>
      </div>
      {draft.description.trim() ? <p className="line-clamp-3 text-subhead text-label">{draft.description.trim()}</p> : null}
      {draft.tweet ? <p className="text-footnote text-label-2">From @{draft.tweet.source.author.handle}&apos;s post · author receives {formatBps(draft.tweet.authorShareBps)} of creator earnings after platform fees</p> : null}
      {selectedQuoteSymbols(draft).length > 1 ? <p className="text-footnote text-label-2">One token · {selectedQuoteSymbols(draft).length} pools · {formatPercent(1 / selectedQuoteSymbols(draft).length)} of supply each</p> : null}
      <dl className="grid grid-cols-2 gap-3 text-footnote">
        <div>
          <dt className="text-label-2">Opens at</dt>
          <dd className="mf-num text-headline text-label">{formatUsd(openingFdvUsd, { compact: true })}</dd>
        </div>
        <div>
          <dt className="text-label-2">Trading fee</dt>
          <dd className="mf-num text-headline text-label">{formatBps(draft.feeBps)}</dd>
        </div>
      </dl>
    </section>
  );
}
