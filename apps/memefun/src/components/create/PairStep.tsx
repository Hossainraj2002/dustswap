"use client";

import { RadioGroup } from "radix-ui";
import { Check, Lock } from "lucide-react";
import { formatUsd } from "@/core/format";
import { cn } from "@/lib/cn";
import { ETH, PREVIEW_STOCKS, USDC } from "@/lib/market/quotes";
import type { QuoteKind } from "@/core/types";
import type { CreateDraft } from "@/lib/create/draft";
import { usePreview } from "@/lib/preview/scenario";
import { Badge } from "@/components/ui/display";

/** Regular US equity session, the hours the stock NAV feeds update. */
export function usMarketOpen(date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday");
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return !["Sat", "Sun"].includes(weekday) && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function OptionCard({ value, selected, disabled, title, subtitle, badge, children }: { value: string; selected: boolean; disabled?: boolean; title: string; subtitle: string; badge?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <RadioGroup.Item
      value={value}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg p-4 text-left transition-[box-shadow,background-color] disabled:opacity-50",
        selected ? "bg-tint/8 shadow-[0_0_0_2px_var(--mf-tint)]" : "bg-bg-elevated shadow-[0_0_0_1px_var(--mf-separator)] hover:bg-fill-4",
      )}
    >
      {children}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-headline text-label">
          {title}
          {badge}
        </span>
        <span className="text-subhead text-label-2">{subtitle}</span>
      </span>
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", selected ? "bg-tint-fill text-on-tint" : "shadow-[inset_0_0_0_1.5px_var(--mf-label-3)]")}>
        {selected ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : null}
      </span>
    </RadioGroup.Item>
  );
}

export function PairStep({
  draft,
  update,
  openingFdvUsd,
  enabledKinds,
}: {
  draft: CreateDraft;
  update: (patch: Partial<CreateDraft>) => void;
  openingFdvUsd: number;
  enabledKinds: QuoteKind[];
}) {
  const { stocksRestricted } = usePreview();
  const stocksOff = !enabledKinds.includes("stock");
  const stockSelected = PREVIEW_STOCKS.some((stock) => stock.symbol === draft.quoteSymbol);
  const open = usMarketOpen();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-subhead text-label-2">
        Your coin trades against this asset, and every trading fee is paid in it. Every pair opens at the same {formatUsd(openingFdvUsd, { compact: true })} market cap.
      </p>
      <RadioGroup.Root
        value={stockSelected ? "stocks" : draft.quoteSymbol}
        onValueChange={(value) => update({ quoteSymbol: value === "stocks" ? (PREVIEW_STOCKS[0]?.symbol ?? "ETH") : value })}
        aria-label="Pair asset"
        className="flex flex-col gap-3"
      >
        <OptionCard
          value={ETH.symbol}
          selected={draft.quoteSymbol === "ETH"}
          disabled={!enabledKinds.includes("native")}
          title="ETH"
          subtitle={enabledKinds.includes("native") ? "Deepest liquidity on Base. Fees are paid in ETH." : "Not available right now."}
          badge={<Badge tone="tint">Recommended</Badge>}
        >
          <QuoteGlyph label="ETH" />
        </OptionCard>
        <OptionCard
          value={USDC.symbol}
          selected={draft.quoteSymbol === "USDC"}
          disabled={!enabledKinds.includes("stable")}
          title="USDC"
          subtitle={enabledKinds.includes("stable") ? "Stable value. Fees are paid in USDC." : "Not available right now."}
        >
          <QuoteGlyph label="$" />
        </OptionCard>
        <OptionCard
          value="stocks"
          selected={stockSelected}
          disabled={stocksRestricted || stocksOff}
          title="Tokenized stock"
          subtitle={
            stocksRestricted ? "Not available in your region." : stocksOff ? "Not available right now." : "Pair with a Coinbase tokenized stock. Fees are paid in that stock."
          }
          badge={stocksRestricted || stocksOff ? <Lock className="size-4 text-label-2" aria-hidden /> : null}
        >
          <QuoteGlyph label="S" />
        </OptionCard>
      </RadioGroup.Root>

      {stockSelected && !stocksRestricted && !stocksOff ? (
        <div className="flex flex-col gap-3">
          <RadioGroup.Root value={draft.quoteSymbol} onValueChange={(value) => update({ quoteSymbol: value })} aria-label="Stock" className="mf-card overflow-hidden [&>*+*]:hairline-t">
            {PREVIEW_STOCKS.map((stock) => (
              <RadioGroup.Item key={stock.symbol} value={stock.symbol} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fill-4 data-[state=checked]:bg-tint/8">
                <QuoteGlyph label={stock.symbol.slice(0, 1)} small />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body font-semibold text-label">{stock.symbol}</span>
                  <span className="truncate text-footnote text-label-2">{stock.name}</span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="mf-num text-subhead text-label">{formatUsd(stock.usdPrice)}</span>
                  <span className={cn("text-caption1 font-semibold", open ? "text-up" : "text-label-2")}>{open ? "Market open" : "Market closed"}</span>
                </span>
                <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", draft.quoteSymbol === stock.symbol ? "bg-tint-fill text-on-tint" : "shadow-[inset_0_0_0_1.5px_var(--mf-label-3)]")}>
                  {draft.quoteSymbol === stock.symbol ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
                </span>
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
          <p className="rounded-md bg-fill-4 px-3 py-2 text-footnote text-label-2">
            Stock prices come from Chainlink and hold their last value outside US market hours. Pairing with a stock gives no ownership of the company.
            Coinbase tokenized stocks are only offered outside the United States.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function QuoteGlyph({ label, small }: { label: string; small?: boolean }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-fill-3 font-rounded font-bold text-label", small ? "size-9 text-subhead" : "size-11 text-callout")} aria-hidden>
      {label}
    </span>
  );
}
