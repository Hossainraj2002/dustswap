"use client";

import { Check, Lock } from "lucide-react";
import { formatCoinAmount, formatPercent, formatUsd } from "@/core/format";
import type { QuoteAsset, QuoteKind } from "@/core/types";
import { cn } from "@/lib/cn";
import { selectedQuoteSymbols, type CreateDraft } from "@/lib/create/draft";
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
  const selected = selectedQuoteSymbols(draft);
  const choose = (symbol: string) => {
    const next = draft.launchMode === "single" ? [symbol] : selected.includes(symbol) ? selected.filter((entry) => entry !== symbol) : [...selected, symbol];
    if (!next.length || next.length > MAX_MARKETS) return;
    const firstBuyQuoteSymbol = next.includes(draft.firstBuyQuoteSymbol) ? draft.firstBuyQuoteSymbol : next[0]!;
    update({ quoteSymbols: next, quoteSymbol: next[0]!, firstBuyQuoteSymbol, firstBuy: firstBuyQuoteSymbol === draft.firstBuyQuoteSymbol ? draft.firstBuy : "" });
  };
  return (
    <div className="flex flex-col gap-5">
      <SegmentedControl label="Number of pools" value={draft.launchMode} onChange={(launchMode) => update({ launchMode,
        quoteSymbols: launchMode === "single" ? [draft.quoteSymbol] : draft.quoteSymbols,
        firstBuyQuoteSymbol: launchMode === "single" ? draft.quoteSymbol : draft.firstBuyQuoteSymbol,
        firstBuy: launchMode === "single" && draft.quoteSymbol !== draft.firstBuyQuoteSymbol ? "" : draft.firstBuy })}
        segments={[{ value: "single", label: "Single pair" }, { value: "multi", label: "Multiple pairs" }]} fullWidth />
      <p className="text-subhead text-label-2">One token, {draft.launchMode === "multi" ? `up to ${MAX_MARKETS} independent pools` : "one pool"}. Fees are paid in each pool&apos;s pair asset. The token opens at {formatUsd(openingFdvUsd)} total market cap.</p>
      {draft.launchMode === "multi" ? <p className="rounded-md bg-fill-4 p-3 text-footnote text-label-2">{selected.length} / {MAX_MARKETS} pools selected. The fixed 1 billion token supply is split equally between them, with any final unit in the last pool. Every pool starts at the same token price and shares one fee policy.</p> : null}
      <div className="flex flex-col gap-3" role="group" aria-label="Pair assets">
        {quotes.map((quote) => {
          const checked = selected.includes(quote.symbol);
          const restricted = stocksRestricted && quote.kind === "stock";
          const disabled = restricted || !enabledKinds.includes(quote.kind) || (!checked && draft.launchMode === "multi" && selected.length >= MAX_MARKETS);
          return <button key={quote.address} type="button" aria-pressed={checked} disabled={disabled} onClick={() => choose(quote.symbol)}
            className={cn("flex min-h-16 items-center gap-3 rounded-lg p-4 text-left disabled:opacity-50", checked ? "bg-tint/8 shadow-[0_0_0_2px_var(--mf-tint)]" : "bg-bg-elevated shadow-[0_0_0_1px_var(--mf-separator)]")}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-fill-3 font-bold text-label">{quote.symbol.slice(0, 1)}</span>
            <span className="flex min-w-0 flex-1 flex-col"><span className="text-headline text-label">{quote.symbol}</span><span className="text-footnote text-label-2">{restricted ? "Not available in your region" : `${quote.name} · ${formatUsd(quote.usdPrice)}`}</span>
              {checked ? <span className="text-footnote text-label-2">{formatPercent(1 / selected.length)} of supply · {formatCoinAmount(Number(equalAllocations(selected.length)[selected.indexOf(quote.symbol)]!) / 1e18)} tokens</span> : null}
            </span>
            {restricted ? <Lock className="size-5 text-label-2" aria-hidden /> : <span className={cn("flex size-6 items-center justify-center rounded-full", checked ? "bg-tint-fill text-on-tint" : "border border-separator")}>{checked ? <Check className="size-4" aria-hidden /> : null}</span>}
          </button>;
        })}
      </div>
      <p className="text-footnote text-label-2">Only listed pair assets are available. Select a chosen pair to remove it; at least one pool is required.</p>
      {quotes.some((quote) => selected.includes(quote.symbol) && quote.kind === "stock") ? <p className="rounded-md bg-fill-4 p-3 text-footnote text-label-2">
        {IS_TESTNET ? "Test stock pairs have no value. Get test stock from the faucet to try a first buy." : "Stock pair prices use Chainlink and retain their last value outside US market hours. Pairing gives no ownership of the company. Coinbase tokenized stocks are offered outside the United States."}
      </p> : null}
    </div>
  );
}
