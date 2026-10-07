"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Gift, Link2, Share } from "lucide-react";
import { getAddress, isAddress, zeroAddress } from "viem";
import { formatQuoteAmount, formatUsd, shortAddress } from "@/core/format";
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
import { AuthorRewardTerms } from "./AuthorRewardTerms";
import { LaunchCampaignClaimCard } from "./LaunchCampaign";

const KIND_LABEL: Record<Claimable["kind"], string> = {
  creator: "Creator earnings",
  holders: "Holder rewards",
  referral: "Referral earnings",
  author: "Post author earnings",
};

function totalsByAsset(items: Claimable[]) {
  const totals = new Map<string, { symbol: string; currency?: string; amount: number }>();
  for (const item of items) {
    const key = item.currency?.toLowerCase() ?? item.quoteSymbol;
    const previous = totals.get(key);
    totals.set(key, { symbol: item.quoteSymbol, currency: item.currency, amount: (previous?.amount ?? 0) + item.amountQuote });
  }
  const symbols = new Map<string, number>();
  for (const { symbol } of totals.values()) symbols.set(symbol, (symbols.get(symbol) ?? 0) + 1);
  return [...totals.values()].map(({ symbol, currency, amount }) =>
    `${formatQuoteAmount(amount, symbol)}${(symbols.get(symbol) ?? 0) > 1 && currency ? ` (${shortAddress(currency)})` : ""}`).join(", ");
}

export function RewardsScreen() {
  const wallet = useWallet();
  const { market } = useMarket();
  const { txOutcome, preview } = usePreview();
  const claimables = useClaimables(wallet.address);
  const { coins } = useCoins();
  const [claiming, setClaiming] = useState<string | null>(null);
  const [payoutWallet, setPayoutWallet] = useState("");
  const walletKey = wallet.address?.toLowerCase() ?? "";
  useEffect(() => { setPayoutWallet(""); }, [walletKey, market]);
  const payoutValid = payoutWallet === "" || (isAddress(payoutWallet) && payoutWallet.toLowerCase() !== zeroAddress);
  const hasCustomPayout = claimables.some((item) => item.kind === "creator" || item.kind === "referral");
  const claimKey = (item: Claimable) => `${item.kind}-${item.coin}-${item.poolId ?? item.currency ?? item.quoteSymbol}-${item.epoch ?? ""}-${item.index ?? ""}`;
  const byAddress = useMemo(() => new Map(coins.map((coin) => [coin.address, coin])), [coins]);
  const total = claimables.reduce((sum, item) => sum + item.amountUsd, 0);

  const claim = async (items: Claimable[], key: string) => {
    const customPayout = items.some((item) => item.kind === "creator" || item.kind === "referral");
    if (!market || !wallet.address || items.length === 0 || (customPayout && !payoutValid)) return;
    setClaiming(key);
    try {
      await market.claim(wallet.address, items, txOutcome, undefined, customPayout && payoutWallet ? getAddress(payoutWallet) : wallet.address);
      toast.success(`Claimed ${totalsByAsset(items)}`, { description: preview ? "Preview claim. Nothing was sent on chain." : "Creator and referral payouts sent to your chosen wallet; holder and author rewards sent to their earning wallet." });
    } catch (error) {
      if (error instanceof TxError && error.kind === "rejected") toast("Claim cancelled", { description: error.message });
      else toast.error("Claim did not go through", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setClaiming(null);
    }
  };

  return (
    <>
      <PageHeader title="Rewards" subtitle="Fees you have earned as a creator, post author, holder or referrer." />
      <LaunchCampaignClaimCard />
      <section className="mf-card mb-5 flex flex-wrap items-center justify-between gap-3 p-4"><div><h2 className="text-headline text-label">Earn from your original X posts</h2><p className="text-footnote text-label-2">Verify your X account and author wallet to claim a tweet coin&apos;s reserved share.</p></div><Button asChild variant="tinted"><Link href="/rewards/author">Post author earnings</Link></Button></section>
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
                  {claimables.length > 0 ? <p className="mf-num text-subhead text-label-2">{totalsByAsset(claimables)}</p> : null}
                </div>
                <Button size="lg" disabled={claimables.length === 0 || (hasCustomPayout && !payoutValid) || (claiming !== null && claiming !== "all")} loading={claiming === "all"} loadingLabel="Confirm in your wallet" onClick={() => void claim(claimables, "all")}>
                  Claim all
                </Button>
              </div>
              <label className="flex flex-col gap-2 text-subhead text-label">Creator and referral payout wallet
                <input aria-label="Reward payout wallet" placeholder={wallet.address} value={payoutWallet} onChange={(event) => setPayoutWallet(event.target.value.trim())} className="rounded-md bg-fill-4 p-3 font-mono text-footnote text-label" />
                <span className="text-footnote text-label-2">Leave empty to use your connected wallet. This applies to this claim only. Holder and author rewards always go to their earning wallet.</span>
                {!payoutValid ? <span className="text-footnote text-down">Enter a valid, nonzero wallet address.</span> : null}
              </label>
              <p className="text-footnote text-label-2">Each pool pays rewards in its own pair asset. USD totals combine their values; different currencies are claimed separately.</p>
              {claimables.some((item) => item.kind === "author") ? <AuthorRewardTerms /> : null}
            </section>

            {(["creator", "author", "holders", "referral"] as const).map((kind) => {
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
                          key={claimKey(item)}
                          item={item}
                          coin={coin}
                          loading={claiming === claimKey(item)}
                          disabled={(!payoutValid && (item.kind === "creator" || item.kind === "referral")) || claiming !== null}
                          onClaim={() => void claim([item], claimKey(item))}
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

function ClaimRow({ item, coin, loading, disabled, onClaim }: { item: Claimable; coin?: Coin; loading: boolean; disabled: boolean; onClaim: () => void }) {
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
      <Button size="sm" variant="tinted" loading={loading} disabled={disabled} loadingLabel="Claiming" onClick={onClaim}>
        Claim
      </Button>
    </div>
  );
}

function EmptyRow({ kind }: { kind: Claimable["kind"] }) {
  if (kind === "author") return <ListRow title="No author earnings ready to claim" subtitle="Verify the original post author's X account and wallet." trailing={<Button asChild size="sm" variant="tinted"><Link href="/rewards/author">Verify author</Link></Button>} />;
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
