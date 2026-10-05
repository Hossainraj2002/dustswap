"use client";

import { useState } from "react";
import { Check, Lock, Search, X } from "lucide-react";
import { formatCoinAmount, formatPercent, formatUsd } from "@/core/format";
import type { QuoteAsset, QuoteKind } from "@/core/types";
import { cn } from "@/lib/cn";
import { selectedQuoteIds, type CreateDraft } from "@/lib/create/draft";
import { usePairCatalog } from "@/lib/market/hooks";
import { findPair, mergePairCatalog, pairId, pairUnavailableReason, type PairCatalogSort } from "@/lib/market/pairs";
import { equalAllocations, MAX_MARKETS } from "@/lib/market/markets";
import { usePreview } from "@/lib/preview/scenario";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { IS_TESTNET } from "@/lib/chain";

export function usMarketOpen(date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return !["Sat", "Sun"].includes(get("weekday")) && minutes >= 570 && minutes < 960;
}

export function PairStep({ draft, update, openingFdvUsd, enabledKinds, quotes }: {
  draft: CreateDraft; update: (patch: Partial<CreateDraft>) => void; openingFdvUsd: number; enabledKinds: QuoteKind[]; quotes: QuoteAsset[];
}) {
  const { stocksRestricted } = usePreview();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PairCatalogSort>("trending");
  const catalog = usePairCatalog(sort);
  const assets = mergePairCatalog(quotes, catalog.quotes);
  const selected = selectedQuoteIds(draft).map(id => findPair(quotes, id)).filter((quote): quote is QuoteAsset => Boolean(quote)).map(pairId);
  const choose = (quote: QuoteAsset) => {
    const id = pairId(quote);
    const alreadySelected = selected.includes(id);
    if (!alreadySelected && (pairUnavailableReason(quote, enabledKinds) || (stocksRestricted && quote.kind === "stock"))) return;
    const next = draft.launchMode === "single" ? [id] : alreadySelected ? selected.filter(entry => entry !== id) : [...selected, id];
    if (!next.length || next.length > MAX_MARKETS) return;
    const previousBuyId = findPair(quotes, draft.firstBuyQuoteId)?.address.toLowerCase();
    const firstBuyQuoteId = previousBuyId && next.includes(previousBuyId) ? previousBuyId : next[0]!;
    update({ quoteIds: next, quoteId: next[0]!, firstBuyQuoteId, firstBuy: firstBuyQuoteId === previousBuyId ? draft.firstBuy : "" });
  };
  const query = search.trim().toLowerCase().replace(/^\$/, "");
  const filtered = assets.filter(quote => !query || [quote.name, quote.symbol, quote.address].some(value => value.toLowerCase().includes(query)));
  const groups: Array<{ label: string; kinds: QuoteKind[] }> = [
    { label: "Main pairs", kinds: ["native", "stable"] }, { label: "Stocks", kinds: ["stock"] }, { label: "Meme tokens", kinds: ["token"] },
  ];
  return (
    <div className="flex flex-col gap-5">
      <SegmentedControl label="Number of pools" value={draft.launchMode} onChange={(launchMode) => update({ launchMode,
        quoteIds: launchMode === "single" ? [draft.quoteId] : draft.quoteIds,
        firstBuyQuoteId: launchMode === "single" ? draft.quoteId : draft.firstBuyQuoteId,
        firstBuy: launchMode === "single" && draft.quoteId !== draft.firstBuyQuoteId ? "" : draft.firstBuy })}
        segments={[{ value: "single", label: "Single pair" }, { value: "multi", label: "Multiple pairs" }]} fullWidth />
      <p className="text-subhead text-label-2">One token, {draft.launchMode === "multi" ? `up to ${MAX_MARKETS} independent pools` : "one pool"}. Fees are paid in each pool&apos;s pair asset. The token opens at {formatUsd(openingFdvUsd)} total market cap.</p>
      {draft.launchMode === "multi" ? <p className="rounded-md bg-fill-4 p-3 text-footnote text-label-2">{selected.length} / {MAX_MARKETS} pools selected. The fixed 1 billion token supply is split equally between them, with any final unit in the last pool. Every pool starts at the same token price and shares one fee policy.</p> : null}
      <div className="flex flex-wrap gap-2" aria-label="Selected pools">
        {selected.map(id => {
          const quote = findPair(quotes, id)!;
          return <button key={id} type="button" aria-label={`Remove ${quote.symbol} ${quote.address}`} disabled={selected.length === 1} onClick={() => choose(quote)} className="inline-flex min-h-9 items-center gap-2 rounded-full bg-tint/10 px-3 text-footnote font-semibold text-tint disabled:opacity-60">
            {quote.symbol}<span className="font-normal">{quote.address.slice(0, 6)}…{quote.address.slice(-4)}</span><X className="size-3.5" aria-hidden />
          </button>;
        })}
      </div>
      <label className="flex items-center gap-2 rounded-lg bg-fill-4 p-3 text-label-2"><Search className="size-5 shrink-0" aria-hidden />
        <input aria-label="Search pair assets" value={search} onChange={event => setSearch(event.target.value.slice(0, 80))} placeholder="Search name, ticker or contract address" className="min-w-0 flex-1 bg-transparent text-subhead text-label outline-none" />
      </label>
      <SegmentedControl label="Meme token discovery" value={sort} onChange={setSort} segments={[{ value: "trending", label: "Trending" }, { value: "newest", label: "Recent" }, { value: "oldest", label: "Established" }]} fullWidth />
      {catalog.notice ? <p role="status" className="text-footnote text-label-2">{catalog.notice}</p> : null}
      <div className="flex flex-col gap-5" role="group" aria-label="Pair assets">
        {groups.map(group => {
          const rows = filtered.filter(quote => group.kinds.includes(quote.kind));
          if (!rows.length) return null;
          return <section key={group.label} aria-label={group.label} className="flex flex-col gap-2">
            <h3 className="text-subhead font-semibold text-label">{group.label} <span className="font-normal text-label-2">{rows.length}</span></h3>
            <div className="grid max-h-[420px] grid-cols-1 gap-2 overflow-y-auto p-0.5 sm:grid-cols-2">
              {rows.map(quote => {
                const id = pairId(quote);
                const checked = selected.includes(id);
                const reason = stocksRestricted && quote.kind === "stock" ? "Stock pairs require an eligible region" : pairUnavailableReason(quote, enabledKinds);
                const atLimit = !checked && draft.launchMode === "multi" && selected.length >= MAX_MARKETS;
                return <button key={id} type="button" aria-label={`${quote.symbol} ${quote.address}`} aria-pressed={checked} disabled={Boolean(reason) || atLimit} onClick={() => choose(quote)}
                  className={cn("flex min-h-20 items-start gap-3 rounded-lg p-3 text-left disabled:opacity-55", checked ? "bg-tint/8 shadow-[0_0_0_2px_var(--mf-tint)]" : "bg-bg-elevated shadow-[0_0_0_1px_var(--mf-separator)]")}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fill-3 font-bold text-label">{quote.symbol.slice(0, 1)}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-headline text-label">{quote.symbol}</span><span className="truncate text-footnote text-label-2">{quote.name}</span>
                    <span className="text-caption1 text-label-2">{quote.address.slice(0, 6)}…{quote.address.slice(-4)}{quote.usdPrice > 0 ? ` · ${formatUsd(quote.usdPrice)}` : " · Price unavailable"}</span>
                    {quote.kind === "token" ? <span className="text-caption1 text-label-2">{quote.rank ? `o1 #${quote.rank} · ` : ""}{quote.createdAt ? `Launched ${new Date(quote.createdAt).toLocaleDateString()}` : "Launch age unavailable"}</span> : null}
                    {reason ? <span className="text-caption1 text-label-2">{reason}</span> : atLimit ? <span className="text-caption1 text-label-2">Five pools selected</span> : checked ? <span className="text-caption1 text-label-2">{formatPercent(1 / selected.length)} of supply · {formatCoinAmount(Number(equalAllocations(selected.length)[selected.indexOf(id)]!) / 1e18)} tokens</span> : null}
                  </span>
                  {reason ? <Lock className="mt-1 size-4 shrink-0 text-label-2" aria-hidden /> : <span className={cn("mt-1 flex size-5 shrink-0 items-center justify-center rounded-full", checked ? "bg-tint-fill text-on-tint" : "border border-separator")}>{checked ? <Check className="size-3.5" aria-hidden /> : null}</span>}
                </button>;
              })}
            </div>
          </section>;
        })}
        {!filtered.length ? <p className="py-4 text-subhead text-label-2">No matching pair assets.</p> : null}
      </div>
      <p className="text-footnote text-label-2">Only listed pair assets are available. Select a chosen pair to remove it; at least one pool is required.</p>
      {quotes.some((quote) => selected.includes(pairId(quote)) && quote.kind === "stock") ? <p className="rounded-md bg-fill-4 p-3 text-footnote text-label-2">
        {IS_TESTNET ? "Test stock pairs have no value. Get test stock from the faucet to try a first buy." : "Stock pair prices use Chainlink and retain their last value outside US market hours. Pairing gives no ownership of the company. Coinbase tokenized stocks are offered outside the United States."}
      </p> : null}
    </div>
  );
}
