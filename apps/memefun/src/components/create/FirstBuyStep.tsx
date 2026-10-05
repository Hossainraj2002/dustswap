"use client";

import { CircleAlert, Zap } from "lucide-react";
import { formatBps, formatCoinAmount, formatPercent, formatQuoteAmount, formatUsd } from "@/core/format";
import type { QuoteAsset } from "@/core/types";
import { previewFirstBuy, type CreateDraft } from "@/lib/create/draft";
import { buyPresets } from "@/lib/trade/cta";
import { useQuoteBalance } from "@/lib/market/hooks";
import { useWallet } from "@/lib/wallet/WalletProvider";

export function FirstBuyStep({ draft, update, quote, quotes = [quote], allocationSupply, openingFdvUsd }: { draft: CreateDraft; update: (patch: Partial<CreateDraft>) => void; quote: QuoteAsset; quotes?: QuoteAsset[]; allocationSupply?: bigint; openingFdvUsd: number }) {
  const wallet = useWallet();
  const balance = useQuoteBalance(wallet.address, quote.symbol);
  const preview = previewFirstBuy(draft.firstBuy, quote, draft.feeBps, openingFdvUsd, allocationSupply);
  const amount = Number(draft.firstBuy) || 0;
  const tooMuch = wallet.status === "connected" && amount > balance;

  return (
    <div className="flex flex-col gap-5">
      {quotes.length > 1 ? <label className="flex flex-col gap-2 text-subhead text-label">First-buy pool
        <select value={quote.symbol} onChange={(event) => update({ firstBuyQuoteSymbol: event.target.value, firstBuy: "" })} className="rounded-md bg-fill-4 p-3 text-label">
          {quotes.map((entry) => <option key={entry.address} value={entry.symbol}>{entry.symbol}</option>)}
        </select><span className="text-footnote text-label-2">Your first buy uses this pool. All other pools launch with no first buy.</span>
      </label> : null}
      <div className="flex gap-3 rounded-lg bg-tint/8 p-4">
        <Zap className="mt-0.5 size-5 shrink-0 text-tint" aria-hidden />
        <p className="text-subhead text-label">
          Your first buy lands in the same transaction as the launch, so nobody can buy before you. It pays the normal {formatBps(draft.feeBps)} fee, not the launch protection fee. Optional.
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-lg bg-fill-4 p-4">
        <div className="flex items-center justify-between text-footnote text-label-2">
          <label htmlFor="first-buy">Spend</label>
          {wallet.status === "connected" ? <span className="mf-num">Balance {formatQuoteAmount(balance, quote.symbol)}</span> : null}
        </div>
        <div className="flex items-center gap-3">
          <input
            id="first-buy"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={draft.firstBuy}
            onChange={(event) => {
              const next = event.target.value.replace(",", ".");
              if (/^\d*\.?\d*$/.test(next) && next.length <= 20) update({ firstBuy: next });
            }}
            className="mf-num min-w-0 flex-1 bg-transparent text-title1 font-bold text-label outline-none placeholder:text-label-3"
          />
          <span className="rounded-full bg-fill-3 px-3 py-1.5 text-subhead font-semibold text-label">{quote.symbol}</span>
        </div>
        <div className="mf-scroll-x flex gap-2 pt-1">
          <button type="button" onClick={() => update({ firstBuy: "" })} className="h-8 shrink-0 rounded-full bg-fill-3 px-3 text-footnote font-semibold text-label hover:bg-fill-2">
            None
          </button>
          {buyPresets(quote.symbol, quote.kind).map((preset) => (
            <button key={preset} type="button" onClick={() => update({ firstBuy: String(preset) })} className="h-8 shrink-0 rounded-full bg-fill-3 px-3 text-footnote font-semibold text-label hover:bg-fill-2">
              {formatQuoteAmount(preset, quote.symbol)}
            </button>
          ))}
        </div>
        {tooMuch ? <p className="text-footnote text-down">That is more than your {quote.symbol} balance.</p> : null}
      </div>

      {preview ? (
        <dl className="rounded-lg bg-fill-4 grid grid-cols-1 gap-3 p-4 text-subhead sm:grid-cols-3">
          <div>
            <dt className="text-label-2">You get</dt>
            <dd className="mf-num text-headline text-label">{formatCoinAmount(preview.coins)} {draft.ticker || "coins"}</dd>
          </div>
          <div>
            <dt className="text-label-2">Share of supply</dt>
            <dd className="mf-num text-headline text-label">{formatPercent(preview.supplyFraction)}</dd>
          </div>
          <div>
            <dt className="text-label-2">Market cap after</dt>
            <dd className="mf-num text-headline text-label">{formatUsd(preview.marketCapUsd, { compact: true })}</dd>
          </div>
        </dl>
      ) : null}

      {preview?.warn ? (
        <div className="flex gap-3 rounded-lg bg-warning/10 p-4" role="status">
          <CircleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
          <p className="text-subhead text-label">
            Buying more than 5% of the supply at launch is shown on your coin page, and buyers often read it as a sign the creator will sell. Consider a smaller first buy.
          </p>
        </div>
      ) : null}
    </div>
  );
}
