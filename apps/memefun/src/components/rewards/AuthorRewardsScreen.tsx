"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isAddress } from "viem";
import { toast } from "sonner";
import { formatBps, formatQuoteAmount, shortAddress } from "@/core/format";
import type { Address } from "@/core/types";
import { useNow } from "@/lib/hooks";
import { authorTreasuryUnlockAt, type AuthorReward } from "@/lib/create/tweet";
import { useCoin, useCoins } from "@/lib/market/hooks";
import { useMarket } from "@/lib/market/MarketProvider";
import { consumeAuthorConnectionFailure } from "@/lib/live/authorCompletion";
import { useWallet } from "@/lib/wallet/WalletProvider";
import type { Coin } from "@/lib/market/types";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { CoinAvatar } from "@/components/ui/CoinAvatar";
import { TweetSourceCard } from "@/components/create/TweetImportPanel";
import { AuthorRewardTerms } from "./AuthorRewardTerms";

export function AuthorRewardCard({ coin }: { coin: Coin }) {
  const tweet = coin.tweet;
  if (!tweet) return null;
  return <section className="mf-card mt-4 flex flex-col gap-3 p-4" aria-label="Post author fee share">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-headline text-label">Post author: {tweet.source ? `@${tweet.source.author.handle}` : `X user ${tweet.authorXUserId}`}</h2>
      <span className="mf-num text-subhead font-semibold text-tint">{formatBps(tweet.authorShareBps)} of creator earnings</span>
    </div>
    <p className="text-footnote text-label-2">This share is calculated after platform fees and applies to every pool. The remaining creator earnings belong to the launcher.</p>
    {tweet.authorWallet ? <p className="text-subhead text-label">Author earning wallet: {shortAddress(tweet.authorWallet)}</p> : null}
    <AuthorRewardTerms />
    <Button asChild variant="tinted"><Link href={`/rewards/author?coin=${coin.address}`}>{tweet.authorWallet ? "View author earnings" : "Verify author and claim"}</Link></Button>
  </section>;
}

export function AuthorRewardsScreen() {
  const wallet = useWallet();
  const { market } = useMarket();
  const { coins } = useCoins();
  const params = useSearchParams();
  const requested = params.get("coin");
  const { coin: requestedCoin } = useCoin(requested && isAddress(requested) ? requested : undefined);
  const session = market?.getAuthorSession(wallet.address ?? undefined) ?? null;
  const rewards = market?.getAuthorRewards(wallet.address ?? undefined) ?? [];
  const isTreasury = market?.isAuthorTreasury(wallet.address ?? undefined) ?? false;
  const now = useNow();
  const [pending, setPending] = useState<string | null>(null);
  const [treasuryBalances, setTreasuryBalances] = useState<Record<string, AuthorReward[]>>({});
  const walletKey = wallet.address?.toLowerCase() ?? "";
  const treasuryContext = useRef({ wallet: walletKey, market, version: 0 });
  if (treasuryContext.current.wallet !== walletKey || treasuryContext.current.market !== market) {
    treasuryContext.current = { wallet: walletKey, market, version: treasuryContext.current.version + 1 };
  }
  useEffect(() => { setTreasuryBalances({}); }, [walletKey, market]);
  const [connectionFailed, setConnectionFailed] = useState(false);
  useEffect(() => { if (consumeAuthorConnectionFailure(window)) setConnectionFailed(true); }, []);
  const allCoins = requestedCoin && !coins.some((coin) => coin.address === requestedCoin.address) ? [requestedCoin, ...coins] : coins;
  const tweetCoins = allCoins.filter((coin) => coin.tweet && (!requested || coin.address.toLowerCase() === requested.toLowerCase()) && (isTreasury || !session || requested || coin.tweet.authorXUserId === session.authorId || coin.tweet.authorWallet?.toLowerCase() === wallet.address?.toLowerCase()));
  const run = async (key: string, action: () => Promise<unknown>, success: string, onChain = false) => {
    if (onChain && !wallet.onBase) { await wallet.switchToBase().catch((failure) => toast.error(failure instanceof Error ? failure.message : "Switch to the supported network.")); return; }
    setPending(key);
    try { await action(); toast.success(success); }
    catch (failure) { toast.error(failure instanceof Error ? failure.message : "The author action did not complete."); }
    finally { setPending(null); }
  };
  const connectX = (coin?: Address) => {
    if (!wallet.address || !market) return;
    setConnectionFailed(false);
    void run("x", () => market.beginAuthorVerification(wallet.address!, coin), market.kind === "preview" ? "X verification simulated in preview" : "Continue verification with X");
  };
  const checkTreasuryBalances = async (coin: Address) => {
    if (!market || !wallet.address || !isTreasury) return;
    const user = wallet.address;
    const contextVersion = treasuryContext.current.version;
    const balances = await market.getTreasuryAuthorRewards(user, coin);
    if (treasuryContext.current.version === contextVersion) setTreasuryBalances((previous) => ({ ...previous, [coin.toLowerCase()]: balances }));
  };
  return <>
    <PageHeader title="Post author earnings" subtitle="Connect your wallet, verify the original X account, then claim its reserved share." />
    <section className="mf-card mb-5 flex flex-col gap-4 p-5">
      {connectionFailed ? <p role="alert" className="rounded-lg bg-warning/10 p-3 text-footnote text-label">X connection did not complete. Connect the wallet you started with, then try connecting X again.</p> : null}
      <ol className="grid grid-cols-1 gap-3 text-subhead text-label sm:grid-cols-3" aria-label="Author verification steps">
        <li>1. Connect your wallet</li><li>2. Verify your X account</li><li>3. Verify wallet on chain and claim</li>
      </ol>
      {wallet.address ? <p className="text-footnote text-label-2">Wallet: {shortAddress(wallet.address)}{session ? ` · X account: @${session.handle}` : " · X account not verified"}</p> : null}
      {isTreasury ? <p className="text-footnote text-label-2">Connected as the DustSwap treasury. Withdrawals pay this configured treasury wallet. X sign-in is not required.</p> : null}
      {market?.kind === "preview" ? <p className="rounded-lg bg-warning/10 p-3 text-footnote text-label">Preview only. X sign-in, author verification and payouts are simulated. No identity is authenticated with X and no transaction is sent.</p> : null}
      {wallet.status !== "connected" ? <Button onClick={() => void wallet.connect()}>Connect wallet</Button> : !session ? <Button disabled={!market || pending !== null} loading={pending === "x"} onClick={() => connectX(tweetCoins[0]?.address)}>{market?.kind === "preview" ? "Simulate author X verification" : "Connect your X account"}</Button> : null}
      {wallet.address && session ? <Button variant="gray" disabled={!market || pending !== null} loading={pending === "x"} onClick={() => connectX(tweetCoins[0]?.address)}>{market?.kind === "preview" ? "Simulate X verification again" : "Reconnect X"}</Button> : null}
      <AuthorRewardTerms />
      {market?.kind === "live" ? <p className="text-footnote text-label-2">Reconnect X if your verification is more than 15 minutes old before verifying a new coin. Already verified author wallets can claim without reconnecting X.</p> : null}
    </section>
    <div className="flex flex-col gap-5">
      {tweetCoins.length ? tweetCoins.map((coin) => {
        const tweet = coin.tweet!;
        const earned = rewards.filter((reward) => reward.coin.toLowerCase() === coin.address.toLowerCase());
        const isAuthor = session?.authorId === tweet.authorXUserId;
        const owner = Boolean(wallet.address && tweet.authorWallet?.toLowerCase() === wallet.address.toLowerCase());
        const treasuryUnlocked = now >= authorTreasuryUnlockAt(tweet);
        const treasuryRows = treasuryBalances[coin.address.toLowerCase()];
        return <section key={coin.address} className="mf-card flex flex-col gap-4 p-5">
          <Link href={`/t/${coin.address}`} className="flex items-center gap-3 text-headline text-label"><CoinAvatar src={coin.image} alt="" symbol={coin.symbol} size={48} />{coin.name} · ${coin.symbol}</Link>
          {tweet.source ? <TweetSourceCard source={tweet.source} /> : <p className="text-subhead text-label">Original X author ID: {tweet.authorXUserId}</p>}
          <p className="text-subhead text-label">Author share: {formatBps(tweet.authorShareBps)} of creator earnings</p>
          {earned.length ? <ul className="flex flex-wrap gap-3 text-subhead text-label">{earned.map((reward) => <li key={`${reward.coin}-${reward.poolId}`}>{formatQuoteAmount(reward.amountQuote, reward.quoteSymbol)}{owner ? " claimable" : " reserved"}</li>)}</ul> : <p className="text-subhead text-label-2">{owner ? "No author earnings ready to claim." : "Author fees are reserved until verification. Claimable amounts appear for the verified author wallet."}</p>}
          {owner ? <Button disabled={pending !== null || !earned.length} loading={pending === coin.address} onClick={() => market && wallet.address && void run(coin.address, () => market.claimAuthorRewards(wallet.address!, coin.address), "Author earnings claimed to the verified wallet", true)}>Claim author earnings</Button>
            : tweet.authorWallet ? <p className="text-footnote text-label-2">Connect {shortAddress(tweet.authorWallet)} to claim author earnings. Author payouts cannot be redirected using the creator payout field.</p>
            : !wallet.address ? <Button onClick={() => void wallet.connect()}>Connect wallet to verify</Button>
            : !isAuthor ? <Button disabled={pending !== null || !market} onClick={() => connectX(coin.address)}>{market?.kind === "preview" ? "Simulate original author verification" : `Verify ${tweet.source ? `@${tweet.source.author.handle}` : "original author"} on X`}</Button>
            : <Button disabled={pending !== null || !market} loading={pending === coin.address} onClick={() => market && void run(coin.address, () => market.bindAuthorWallet(wallet.address!, coin.address), "Author earning wallet verified for this coin", true)}>Verify this wallet on chain</Button>}
          {isTreasury ? <section className="flex flex-col gap-3 border-t border-separator pt-4" aria-label="Treasury withdrawals">
            <h3 className="text-headline text-label">Treasury withdrawals</h3>
            <Button variant="gray" disabled={pending !== null || !market} loading={pending === `treasury-check:${coin.address}`} onClick={() => void run(`treasury-check:${coin.address}`, () => checkTreasuryBalances(coin.address), "Unpaid author balances refreshed")}>Check unpaid balances</Button>
            {!treasuryUnlocked ? <p className="text-footnote text-label-2">Withdrawals unlock {new Date(authorTreasuryUnlockAt(tweet)).toLocaleString()}.</p> : null}
            {treasuryRows ? treasuryRows.length ? <ul className="flex flex-col gap-3">{treasuryRows.map((reward) => <li key={reward.poolId} className="flex flex-wrap items-center justify-between gap-3">
              <span className="mf-num text-subhead text-label">{formatQuoteAmount(reward.amountQuote, reward.quoteSymbol)} unpaid</span>
              <Button variant="tinted" disabled={!treasuryUnlocked || pending !== null || reward.amountQuote <= 0} loading={pending === `treasury:${reward.poolId}`} onClick={() => market && wallet.address && void run(`treasury:${reward.poolId}`, async () => {
                await market.claimTreasuryAuthorRewards(wallet.address!, coin.address, reward.poolId);
                await checkTreasuryBalances(coin.address);
              }, "Unpaid author rewards withdrawn to the treasury wallet", true)}>Withdraw {reward.quoteSymbol}</Button>
            </li>)}</ul> : <p className="text-footnote text-label-2">No unpaid author rewards are available.</p> : null}
          </section> : null}
        </section>;
      }) : <div className="mf-card p-5"><p className="mb-4 text-subhead text-label-2">{session ? "No coins linked to this X author are loaded yet. Open the coin's author earnings link to verify it." : "Open a tweet coin to verify its original author, or launch one from a public post."}</p><Button asChild variant="tinted"><Link href="/create/tweet">Launch by tweet</Link></Button></div>}
    </div>
  </>;
}
