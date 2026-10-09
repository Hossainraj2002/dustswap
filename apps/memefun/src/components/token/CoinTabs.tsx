"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, Info, Lock, ShieldCheck } from "lucide-react";
import { DEAD_ADDRESS } from "@/core/constants";
import { formatAge, formatBps, formatCoinAmount, formatPercent, formatQuoteAmount, formatUsd, shortAddress } from "@/core/format";
import { IS_TESTNET, explorerUrl } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/hooks";
import { useComments, useHolders, useTrades } from "@/lib/market/hooks";
import { useMarket } from "@/lib/market/MarketProvider";
import type { Coin, Holder } from "@/lib/market/types";
import { usePreview } from "@/lib/preview/scenario";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { AddressAvatar } from "@/components/ui/AddressAvatar";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState } from "@/components/ui/display";
import { MODE_META } from "@/components/ui/ModeBadge";
import { Tabs } from "@/components/ui/Tabs";
import { TextArea } from "@/components/ui/TextField";
import { ConnectHint } from "@/components/shell/WalletButton";

type TabKey = "trades" | "holders" | "comments" | "about" | "safety";

export function CoinTabs({ coin, official = false }: { coin: Coin; official?: boolean }) {
  const [tab, setTab] = useState<TabKey>("trades");
  const comments = useComments(coin.address);
  return (
    <Tabs<TabKey>
      label="Coin details"
      value={tab}
      onChange={setTab}
      items={[
        { value: "trades", label: "Trades", content: <TradesTab coin={coin} official={official} /> },
        { value: "holders", label: "Holders", count: coin.holders, content: <HoldersTab coin={coin} official={official} /> },
        { value: "comments", label: "Comments", count: comments.length, content: <CommentsTab coin={coin} /> },
        { value: "about", label: "About", content: <AboutTab coin={coin} /> },
        { value: "safety", label: "Safety", content: <SafetyTab coin={coin} official={official} /> },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ trades */

function TradesTab({ coin, official }: { coin: Coin; official: boolean }) {
  const [limit, setLimit] = useState(20);
  const trades = useTrades(coin.address, limit + 1, coin.selectedPoolId);
  const wallet = useWallet();
  const now = useNow();
  if (trades.length === 0) return <EmptyState title="No trades yet" message="The first buy sets the chart in motion." className="mf-card mt-3" />;
  return (
    <div className="mt-3 flex flex-col gap-3">
    <ol className="mf-card overflow-hidden [&>li+li]:hairline-t" aria-label="Latest trades">
      {trades.slice(0, limit).map((trade) => {
        const you = wallet.address !== null && trade.trader.toLowerCase() === wallet.address.toLowerCase();
        return (
          <li key={trade.id} className="flex items-center gap-3 px-4 py-2.5">
            <span
              className={cn(
                "flex h-6 w-11 shrink-0 items-center justify-center rounded-[6px] text-caption1 font-bold",
                trade.side === "buy" ? "bg-up/10 text-up" : "bg-down/10 text-down",
              )}
            >
              {trade.side === "buy" ? "Buy" : "Sell"}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="mf-num truncate text-subhead text-label">
                {formatQuoteAmount(trade.quoteAmount, coin.quote.symbol)}
                <span className="text-label-2"> for </span>
                {formatCoinAmount(trade.coinAmount)}
              </span>
              <span className="flex items-center gap-1.5 truncate text-footnote text-label-2">
                <AddressAvatar address={trade.trader} size={14} />
                {you ? <Badge tone="tint">You</Badge> : trade.isCreator ? <Badge tone={official ? "tint" : "warning"}>{official ? "Platform" : "Dev"}</Badge> : shortAddress(trade.trader)}
                {trade.inProtection ? <span className="text-warning">paid {formatBps(trade.feeBps)} launch fee</span> : null}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end">
              <span className="mf-num text-footnote text-label">{formatUsd(trade.marketCapUsd, { compact: true })}</span>
              <span className="mf-num text-caption1 text-label-2">{now > 0 ? formatAge(now - trade.ts) : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
    {trades.length > limit && limit < 100 ? (
      <Button variant="gray" className="self-center" onClick={() => setLimit((current) => current + 20)}>
        Show more trades
      </Button>
    ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- holders */

function holderName(holder: Holder, official: boolean) {
  switch (holder.label) {
    case "pool":
      return "Uniswap v4 pool (locked)";
    case "burn":
      return "Burn address";
    case "creator":
      return official ? "Platform wallet" : "Creator";
    case "you":
      return "You";
    default:
      return shortAddress(holder.address);
  }
}

function HoldersTab({ coin, official }: { coin: Coin; official: boolean }) {
  const holders = useHolders(coin.address, 22);
  return (
    <ol className="mf-card mt-3 overflow-hidden [&>li+li]:hairline-t" aria-label="Top holders">
      {holders.map((holder, index) => (
        <li key={`${holder.address}-${holder.label ?? ""}`} className="flex items-center gap-3 px-4 py-2.5">
          <span className="mf-num w-5 shrink-0 text-center text-footnote text-label-2">{index + 1}</span>
          {holder.label === "pool" ? (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-tint/10 text-tint">
              <Lock className="size-3.5" aria-hidden />
            </span>
          ) : holder.address === DEAD_ADDRESS ? (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-mode-burn/14 text-mode-burn">
              {(() => {
                const Icon = MODE_META.burn.icon;
                return <Icon className="size-3.5" aria-hidden />;
              })()}
            </span>
          ) : (
            <AddressAvatar address={holder.address} size={28} />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-1.5 truncate text-subhead text-label">
              {holderName(holder, official)}
              {holder.label === "creator" ? <Badge tone={official ? "tint" : "warning"}>{official ? "Platform" : "Dev"}</Badge> : null}
            </span>
            <span className="h-1 w-full overflow-hidden rounded-full bg-fill-3" aria-hidden>
              <span className="block h-full rounded-full bg-tint-fill" style={{ width: `${Math.min(100, holder.pct * 100)}%` }} />
            </span>
          </span>
          <span className="mf-num w-16 shrink-0 text-right text-subhead font-semibold text-label">{formatPercent(holder.pct)}</span>
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------------- comments */

function CommentsTab({ coin }: { coin: Coin }) {
  const comments = useComments(coin.address);
  const wallet = useWallet();
  const { market } = useMarket();
  const now = useNow();
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const post = async () => {
    if (!market || !wallet.address) return;
    setPosting(true);
    try {
      await market.addComment(wallet.address, coin.address, draft);
      setDraft("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not post.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="mf-card p-4">
        {wallet.status === "connected" ? (
          <div className="flex flex-col gap-3">
            <TextArea label="Add a comment" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={280} showCounter rows={2} placeholder={`Say something about ${coin.symbol}`} />
            <div className="flex items-center justify-between gap-3">
              <p className="text-caption1 text-label-2">Posting signs a message with your wallet. It costs nothing.</p>
              <Button size="sm" onClick={() => void post()} loading={posting} loadingLabel="Posting" disabled={!draft.trim()}>
                Post
              </Button>
            </div>
          </div>
        ) : (
          <ConnectHint action="join the conversation" />
        )}
      </div>
      {comments.length === 0 ? (
        <EmptyState title="No comments yet" message="Start the conversation." className="mf-card" />
      ) : (
        <ol className="mf-card overflow-hidden [&>li+li]:hairline-t" aria-label="Comments">
          {comments.map((comment) => {
            const you = wallet.address === comment.author;
            return (
              <li key={comment.id} className="flex gap-3 px-4 py-3">
                <AddressAvatar address={comment.author} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-footnote text-label-2">
                    <span className="font-semibold text-label">{you ? "You" : shortAddress(comment.author)}</span>
                    {comment.isCreator ? <Badge tone="warning">Creator</Badge> : null}
                    <span>{now > 0 ? `${formatAge(now - comment.ts)} ago` : ""}</span>
                  </p>
                  <p className="mt-0.5 break-words text-subhead text-label">{comment.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- about */

function AboutTab({ coin }: { coin: Coin }) {
  const { preview } = usePreview();
  const meta = MODE_META[coin.terms.mode];
  const rows: Array<[string, React.ReactNode]> = [
    ["Selected pair", `${coin.symbol} / ${coin.quote.symbol}`],
    ["All pairs", coin.markets?.map((market) => market.quote.symbol).join(", ") || coin.quote.symbol],
    ["Supply", "1,000,000,000, fixed forever"],
    ["Trading fee", `${formatBps(coin.terms.feeBps)} of every trade, can only go down`],
    ["Fees go to", coin.tweet ? `Post author ${formatBps(coin.tweet.authorShareBps)}, launcher ${formatBps(10_000 - coin.tweet.authorShareBps)} of creator earnings after platform fees` : coin.terms.mode === "creator" ? "Creator" : `${meta.destinationLabel}${coin.terms.creatorKeepBps > 0 ? `, creator keeps ${formatBps(coin.terms.creatorKeepBps)} of that share` : ""}`],
    ["Platform share", `${formatBps(coin.terms.platformShareBps)} of each fee`],
    ["Launch protection", `${formatBps(coin.terms.snipeStartBps)} fee at launch, normal after ${coin.terms.snipeDurationSec}s`],
    ["Opening market cap", formatUsd(coin.openingMarketCapUsd)],
    ["Created", new Date(coin.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })],
    ["Contract", <span key="contract" className="mf-num break-all font-mono text-footnote">{coin.address}</span>],
  ];
  return (
    <div className="mt-3 flex flex-col gap-3">
      {coin.description ? <p className="mf-card p-4 text-body text-label">{coin.description}</p> : null}
      <dl className="mf-card overflow-hidden [&>div+div]:hairline-t">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
            <dt className="shrink-0 text-subhead text-label-2">{label}</dt>
            <dd className="text-subhead text-label sm:text-right">{value}</dd>
          </div>
        ))}
      </dl>
      {coin.quote.kind === "stock" ? (
        <p className="mf-card p-4 text-footnote text-label-2">
          This coin is paired with {coin.quote.name}. Holding the coin does not give you any ownership of the company or rights to its shares.
          {IS_TESTNET ? " The test stock has no value." : " Coinbase tokenized stocks are only offered outside the United States."}
        </p>
      ) : null}
      {!preview && explorerUrl("token", coin.address) ? (
        <a href={explorerUrl("token", coin.address) ?? undefined} target="_blank" rel="noopener noreferrer" className="text-center text-subhead font-semibold text-tint">
          View on Basescan
        </a>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ safety */

function SafetyTab({ coin, official }: { coin: Coin; official: boolean }) {
  const guarantees = [
    "Fixed supply of 1,000,000,000. Nobody can mint more.",
    "No admin or owner. Nobody can pause, block or seize transfers.",
    "The fixed supply was split between the launch pools.",
    "Liquidity is locked forever. Nobody can withdraw it.",
    `Trading fee is ${formatBps(coin.terms.feeBps)} and can only go down.`,
    `Fees always go to the same place: ${MODE_META[coin.terms.mode].label.toLowerCase()}.`,
  ];
  const checks: Array<{ label: string; value: string; tone: "good" | "caution" | "neutral"; note: string }> = [
    {
      label: "Top 10 holders",
      value: formatPercent(coin.top10Pct),
      tone: coin.top10Pct > 0.35 ? "caution" : "good",
      note: "Share of supply held by the 10 largest wallets, not counting the pool or burn address.",
    },
    {
      label: official ? "Platform wallet holds" : "Creator holds",
      value: formatPercent(coin.devHoldsPct),
      tone: official ? "neutral" : coin.devHoldsPct > 0.05 ? "caution" : "good",
      note: official ? (coin.devSold ? "The platform wallet has sold some coins." : "The platform wallet has not sold any coins.")
        : coin.devSold ? "The creator has sold some coins." : "The creator has not sold any coins.",
    },
    {
      label: "Launch snipers",
      value: String(coin.snipers),
      tone: coin.snipers > 5 ? "caution" : "good",
      note: "Wallets that bought during launch protection and paid the higher fee.",
    },
    {
      label: "Same-block buys",
      value: String(coin.sameBlockBuys),
      tone: coin.sameBlockBuys > 6 ? "caution" : "good",
      note: "Buys from different wallets in the same block in the first minute, a sign of bundled wallets.",
    },
  ];
  return (
    <div className="mt-3 flex flex-col gap-3">
      <section aria-labelledby="guarantees" className="mf-card p-4">
        <h3 id="guarantees" className="mb-3 flex items-center gap-2 text-headline text-label">
          <ShieldCheck className="size-5 text-up" aria-hidden />
          Guaranteed by the contracts
        </h3>
        <ul className="flex flex-col gap-2.5">
          {guarantees.map((text) => (
            <li key={text} className="flex gap-2.5 text-subhead text-label">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-up" aria-hidden />
              {text}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="signals" className="mf-card overflow-hidden">
        <h3 id="signals" className="px-4 pb-1 pt-4 text-headline text-label">
          Market signals
        </h3>
        <dl className="[&>div+div]:hairline-t">
          {checks.map((check) => (
            <div key={check.label} className="flex gap-3 px-4 py-3">
              {check.tone === "good" ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-up" aria-hidden />
              ) : check.tone === "neutral" ? (
                <Info className="mt-0.5 size-4 shrink-0 text-tint" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <dt className="flex justify-between gap-3 text-subhead text-label">
                  {check.label}
                  <span className={cn("mf-num font-semibold", check.tone === "caution" ? "text-warning" : "text-label")}>{check.value}</span>
                </dt>
                <dd className="text-footnote text-label-2">{check.note}</dd>
              </div>
            </div>
          ))}
        </dl>
      </section>
      <p className="px-1 text-footnote text-label-2">
        Meme coins are volatile and can lose most of their value. Signals describe trading so far and are not advice.{" "}
        <Link href="/how-it-works" className="font-semibold text-tint">
          How memefun works
        </Link>
      </p>
    </div>
  );
}
