"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { formatUnits } from "viem";
import { toast } from "sonner";
import type { LaunchCampaignSummary, LaunchCampaignWalletStatus } from "@/core/campaign";
import { useLaunchCampaign } from "@/lib/campaign/useLaunchCampaign";
import { useMarket } from "@/lib/market/MarketProvider";
import { TxError, type TxStage } from "@/lib/market/Market";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { Button } from "@/components/ui/Button";

type Active = Extract<LaunchCampaignSummary, { enabled: true }>;
export function campaignReward(summary: Active): string {
  return `${formatUnits(BigInt(summary.rewardAmountRaw), summary.token.decimals)} ${summary.token.symbol}`;
}
export function campaignRule(summary: Active): string {
  return BigInt(summary.tradeRequiredFromBlock) > 0n
    ? "Launch a token, then trade any MemeFun token to qualify. Earlier qualifying launches keep their original rules."
    : "Launch a token during this campaign to qualify.";
}
export function campaignWalletMessage(status: LaunchCampaignWalletStatus | null): string {
  if (!status) return "Checking this wallet’s eligibility…";
  return {
    launch_required: "Launch a token during this campaign to qualify.",
    confirming: "Your eligibility will update after the launch is finalized and indexed.",
    trade_required: "Your allocation is reserved. Trade any MemeFun token after your launch to unlock it.",
    eligible: "Your reward is ready to claim to this wallet.",
    claimed: "This wallet has claimed its campaign reward.",
    full: "All 1,000 launch allocations have been reserved.",
  }[status.state];
}

export function LaunchCampaignBanner() {
  const { summary } = useLaunchCampaign();
  if (!summary?.enabled) return null;
  const full = summary.qualifiedCount >= summary.maxRecipients;
  return <section aria-label="Launch rewards" className="mf-card mb-5 flex flex-wrap items-center justify-between gap-4 border border-tint/20 p-5">
    <div className="min-w-0"><h2 className="break-words text-headline text-label">{full ? "Launch reward allocations filled" : `Launch a token to earn ${campaignReward(summary)}`}</h2>
      <p className="mt-1 text-subhead text-label-2">{full ? "Eligible wallets can claim in Rewards." : campaignRule(summary)}</p>
      <p className="mt-2 text-footnote text-label-2">First 1,000 distinct launcher wallets · One reward per wallet · {Math.max(0, summary.maxRecipients - summary.qualifiedCount)} allocations left</p>
    </div>
    <Button asChild variant="tinted"><Link href={full ? "/rewards" : "/create"}>{full ? "View rewards" : "Launch a token"}</Link></Button>
  </section>;
}

export function LaunchCampaignClaimCard() {
  const { summary, wallet: eligibility, error, refresh } = useLaunchCampaign(true);
  const wallet = useWallet();
  const { market } = useMarket();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<TxStage | null>(null);
  const lock = useRef(false);
  if (!summary?.enabled) return null;
  const claim = async () => {
    if (lock.current || !wallet.address || !market?.claimLaunchCampaign || eligibility?.state !== "eligible") return;
    lock.current = true;
    setBusy(true);
    setStage(null);
    try {
      await market.claimLaunchCampaign(wallet.address, setStage);
      toast.success("Launch reward claimed", { description: "The tokens were sent to your qualifying wallet." });
      refresh();
    } catch (cause) {
      if (cause instanceof TxError && cause.kind === "rejected") toast("Claim cancelled");
      else toast.error("Reward claim did not go through", { description: cause instanceof Error ? cause.message : "Refresh your eligibility and try again." });
      refresh();
    } finally { lock.current = false; setBusy(false); setStage(null); }
  };
  return <section aria-label="Platform token launch reward" className="mf-card mb-5 p-5 sm:p-6">
    <h2 className="break-words text-title3 font-semibold text-label">{summary.token.name} launch reward</h2>
    <p className="mt-2 break-words text-title2 font-bold text-tint">{campaignReward(summary)}</p>
    <p className="mt-2 text-subhead text-label-2">{eligibility?.launchBlock && !eligibility.tradeRequired
      ? "Your qualifying launch follows the launch-only reward rule."
      : campaignRule(summary)}</p>
    <p className="mt-2 text-footnote text-label-2">First 1,000 distinct launcher wallets. One equal reward per wallet, paid to the wallet that launched.</p>
    {!wallet.address ? <p className="mt-4 text-subhead text-label-2">Connect your wallet to check your allocation.</p>
      : <p role="status" className="mt-4 text-subhead text-label">{error ? "Eligibility could not be loaded. Try refreshing." : campaignWalletMessage(eligibility)}</p>}
    <div className="mt-4 flex flex-wrap gap-3">
      {!wallet.address ? <Button loading={busy} onClick={async () => { if (lock.current) return; lock.current = true; setBusy(true); try { await wallet.connect(); } catch { toast.error("Wallet connection did not complete"); } finally { lock.current = false; setBusy(false); } }}>Connect wallet</Button>
        : <Button disabled={error || eligibility?.state !== "eligible" || busy || !market?.claimLaunchCampaign} loading={busy} loadingLabel={stage === "pending" ? "Confirming claim" : stage === "confirm" ? "Confirm in your wallet" : "Preparing claim"} onClick={() => void claim()}>Claim launch reward</Button>}
      <Button variant="gray" disabled={busy} onClick={refresh}>Refresh eligibility</Button>
      {eligibility?.state === "launch_required" ? <Button asChild variant="tinted"><Link href="/create">Launch a token</Link></Button> : null}
      {eligibility?.state === "trade_required" ? <Button asChild variant="tinted"><Link href="/">Find a token to trade</Link></Button> : null}
    </div>
  </section>;
}
