"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Gift, Link2, Share } from "lucide-react";
import { formatQuoteAmount, formatUsd } from "@/core/format";
import { useClaimables, useCoins } from "@/lib/market/hooks";
import { useMarket } from "@/lib/market/MarketProvider";
import type { Claimable, Coin } from "@/lib/market/types";
import { TxError } from "@/lib/market/Market";
import { usePreview } from "@/lib/preview/scenario";
import { referralLink } from "@/lib/referrals";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { PageHeader } from "@/components/shell/PageHeader";
import { ConnectHint } from "@/components/shell/WalletButton";
import { UsdFlow } from "@/components/coin/CoinBits";
import { Button } from "@/components/ui/Button";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { CopyButton } from "@/components/ui/CopyButton";
import { List, ListRow } from "@/components/ui/display";

const KIND_LABEL: Record<Claimable["kind"], string> = {
  creator: "Creator earnings",
  holders: "Holder rewards",
  referral: "Referral earnings",
};

function totalsBySymbol(items: Claimable[]) {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.quoteSymbol, (totals.get(item.quoteSymbol) ?? 0) + item.amountQuote);
  return [...totals.entries()].map(([symbol, amount]) => formatQuoteAmount(amount, symbol)).join(", ");
}

export function RewardsScreen() {
  const wallet = useWallet();
  const { market } = useMarket();
  const { txOutcome, preview } = usePreview();
  const claimables = useClaimables(wallet.address);
  const { coins } = useCoins();
  const [claiming, setClaiming] = useState<string | null>(null);
  const byAddress = useMemo(() => new Map(coins.map((coin) => [coin.address, coin])), [coins]);
  const total = claimables.reduce((sum, item) => sum + item.amountUsd, 0);

  const claim = async (items: Claimable[], key: string) => {
    if (!market || !wallet.address || items.length === 0) return;
    setClaiming(key);
    try {
      await market.claim(wallet.address, items, txOutcome);
      toast.success(`Claimed ${totalsBySymbol(items)}`, { description: preview ? "Preview claim. Nothing was sent on chain." : "Sent to your wallet." });
    } catch (error) {
      if (error instanceof TxError && error.kind === "rejected") toast("Claim cancelled", { description: error.message });
      else toast.error("Claim did not go through", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setClaiming(null);
    }
  };

  return (
    <>
      <PageHeader title="Rewards" subtitle="Fees you have earned as a creator, a holder or a referrer." />
      {wallet.status !== "connected" || !wallet.address ? (
        <div className="mf-card">
          <ConnectHint action="see and claim your rewards" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-6">
            <section aria-labelledby="claimable" className="mf-card flex flex-col gap-4 p-5 sm:p-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 id="claimable" className="text-footnote font-semibold uppercase tracking-wide text-label-2">
                    Ready to claim
                  </h2>
                  <UsdFlow value={total} compact={false} className="text-large-title font-bold text-label" />
                  {claimables.length > 0 ? <p className="mf-num text-subhead text-label-2">{totalsBySymbol(claimables)}</p> : null}
                </div>
                <Button size="lg" disabled={claimables.length === 0} loading={claiming === "all"} loadingLabel="Confirm in your wallet" onClick={() => void claim(claimables, "all")}>
                  Claim all
                </Button>
              </div>
              <p className="text-footnote text-label-2">Rewards are paid in the asset each coin trades against. Claiming sends them straight to your wallet.</p>
            </section>

            {(["creator", "holders", "referral"] as const).map((kind) => {
              const items = claimables.filter((item) => item.kind === kind);
              return (
                <List key={kind} header={KIND_LABEL[kind]}>
                  {items.length === 0 ? (
                    <EmptyRow kind={kind} />
                  ) : (
                    items.map((item) => {
                      const coin = byAddress.get(item.coin);
                      return (
                        <ClaimRow
                          key={`${item.kind}-${item.coin}`}
                          item={item}
                          coin={coin}
                          loading={claiming === `${item.kind}-${item.coin}`}
                          onClaim={() => void claim([item], `${item.kind}-${item.coin}`)}
                        />
                      );
                    })
                  )}
                </List>
              );
            })}
          </div>
          <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
            <ReferralCard address={wallet.address} />
          </aside>
        </div>
      )}
    </>
  );
}

function ClaimRow({ item, coin, loading, onClaim }: { item: Claimable; coin?: Coin; loading: boolean; onClaim: () => void }) {
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-2.5">
      {coin ? <CoinAvatar src={coin.image} alt="" size={40} symbol={coin.symbol} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {coin ? (
          <Link href={`/t/${coin.address}`} className="truncate text-body font-semibold text-label hover:underline">
            {coin.name}
          </Link>
        ) : (
          <span className="text-body text-label">Coin</span>
        )}
        <span className="mf-num text-subhead text-label-2">
          {formatQuoteAmount(item.amountQuote, item.quoteSymbol)}, {formatUsd(item.amountUsd)}
        </span>
      </div>
      <Button size="sm" variant="tinted" loading={loading} loadingLabel="Claiming" onClick={onClaim}>
        Claim
      </Button>
    </div>
  );
}

function EmptyRow({ kind }: { kind: Claimable["kind"] }) {
  if (kind === "creator") {
    return (
      <ListRow
        title="Nothing to claim yet"
        subtitle="Launch a coin and earn part of every trade's fee."
        trailing={
          <Button asChild size="sm" variant="tinted">
            <Link href="/create">Create</Link>
          </Button>
        }
      />
    );
  }
  if (kind === "holders") return <ListRow title="Nothing to claim yet" subtitle="Hold coins that pay holders to earn a share of their fees." />;
  return <ListRow title="Nothing to claim yet" subtitle="Share your link below. You earn when people you bring trade." />;
}

function ReferralCard({ address }: { address: string }) {
  const link = referralLink("/", address);
  const share = async () => {
    const text = "Launch and trade meme coins on Base. Fixed supply, no admin keys, liquidity locked forever.";
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      await navigator.share({ title: "memefun", text, url: link }).catch(() => {});
    } else {
      window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`, "_blank", "noopener,noreferrer");
    }
  };
  return (
    <section aria-labelledby="referral" className="mf-card flex flex-col gap-4 p-5">
      <span className="flex size-11 items-center justify-center rounded-full bg-tint/10 text-tint">
        <Gift className="size-5" aria-hidden />
      </span>
      <div>
        <h2 id="referral" className="text-title3 text-label">
          Earn from your link
        </h2>
        <p className="mt-1 text-subhead text-label-2">
          When people who open your link trade on memefun, you get a quarter of the platform&apos;s share of their fees. Their fees do not go up.
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-md bg-fill-4 py-1 pl-3 pr-1">
        <Link2 className="size-4 shrink-0 text-label-2" aria-hidden />
        <span className="mf-num min-w-0 flex-1 truncate text-footnote text-label">{link.replace(/^https?:\/\//, "")}</span>
        <CopyButton value={link} label="Copy referral link" />
      </div>
      <Button variant="tinted" leading={<Share className="size-4" aria-hidden />} onClick={() => void share()}>
        Share link
      </Button>
    </section>
  );
}
