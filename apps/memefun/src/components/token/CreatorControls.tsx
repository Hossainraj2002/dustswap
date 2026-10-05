"use client";

import { useState } from "react";
import { getAddress, isAddress, zeroAddress } from "viem";
import { toast } from "sonner";
import { formatBps, shortAddress } from "@/core/format";
import type { Coin } from "@/lib/market/types";
import { parseFeePercent } from "@/lib/market/creator";
import { TxError } from "@/lib/market/Market";
import { useMarket } from "@/lib/market/MarketProvider";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { Button } from "@/components/ui/Button";

export function CreatorControls({ coin }: { coin: Coin }) {
  const wallet = useWallet();
  const { market } = useMarket();
  const [fee, setFee] = useState("");
  const [proposed, setProposed] = useState("");
  const [pending, setPending] = useState(false);
  const isCreator = wallet.address?.toLowerCase() === coin.creator.toLowerCase();
  const canAccept = wallet.address?.toLowerCase() === coin.pendingCreator?.toLowerCase();
  if (!isCreator && !canAccept) return null;
  const newFee = parseFeePercent(fee);
  const feeValid = newFee !== null && newFee < coin.terms.feeBps;
  const transferValid = isAddress(proposed) && proposed.toLowerCase() !== zeroAddress && proposed.toLowerCase() !== coin.creator.toLowerCase();
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (!wallet.onBase) { await wallet.switchToBase().catch((error) => toast.error(error instanceof Error ? error.message : "Switch your wallet network.")); return; }
    setPending(true);
    try { await action(); toast.success(message); setFee(""); setProposed(""); }
    catch (error) {
      if (error instanceof TxError && error.kind === "rejected") toast("Change cancelled", { description: error.message });
      else toast.error(error instanceof Error ? error.message : "The change did not go through.");
    }
    finally { setPending(false); }
  };
  return <details className="mf-card mt-4 p-4">
    <summary className="cursor-pointer text-headline text-label">Creator controls</summary>
    <div className="mt-4 flex flex-col gap-5">
      <p className="text-footnote text-label-2">These controls apply to every pool. Fee destination and split percentages stay fixed.</p>
      {coin.tweet ? <p className="text-footnote text-label-2">The post author&apos;s split and verified wallet stay separate. Transferring creator control transfers only the launcher&apos;s rights and earnings.</p> : null}
      {isCreator && market && wallet.address ? <>
        <label className="flex flex-col gap-2 text-subhead text-label">Lower trading fee (currently {formatBps(coin.terms.feeBps)})
          <input aria-label="New trading fee percent" inputMode="decimal" placeholder="Fee percent" value={fee} onChange={(event) => setFee(event.target.value)} className="rounded-md bg-fill-4 p-3 text-label" />
          <span className="text-footnote text-label-2">A reduction is permanent. You can lower it to zero; it can never be raised.</span>
        </label>
        <Button disabled={!feeValid || pending} loading={pending} onClick={() => void run(() => market.lowerFee(wallet.address!, coin.address, newFee!), "Trading fee lowered for every pool")}>Lower fee</Button>
        <label className="flex flex-col gap-2 text-subhead text-label">Transfer creator control
          <input aria-label="New creator wallet" placeholder="0x…" value={proposed} onChange={(event) => setProposed(event.target.value.trim())} className="rounded-md bg-fill-4 p-3 font-mono text-label" />
          <span className="text-footnote text-label-2">The new wallet receives fee control and all unclaimed creator earnings. It must accept the transfer. This is different from choosing a wallet for one reward payout.</span>
        </label>
        <Button disabled={!transferValid || pending} onClick={() => void run(() => market.proposeCreator(wallet.address!, coin.address, getAddress(proposed)), "Creator transfer proposed")}>Propose transfer</Button>
        {coin.pendingCreator ? <div className="flex flex-wrap items-center gap-3"><p className="text-subhead text-label">Waiting for {shortAddress(coin.pendingCreator)} to accept.</p>
          <Button variant="gray" disabled={pending} onClick={() => void run(() => market.proposeCreator(wallet.address!, coin.address, zeroAddress), "Transfer cancelled")}>Cancel proposal</Button></div> : null}
      </> : null}
      {canAccept && market && wallet.address ? <><p className="text-subhead text-label">You have been proposed as the new creator. Accepting transfers fee control and unclaimed earnings for all pools to this wallet.</p>
        <Button disabled={pending} onClick={() => void run(() => market.acceptCreator(wallet.address!, coin.address), "Creator transfer accepted")}>Accept creator transfer</Button></> : null}
    </div>
  </details>;
}
