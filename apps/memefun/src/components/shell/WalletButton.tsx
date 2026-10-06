"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LogOut, TriangleAlert, UserRound, Gift } from "lucide-react";
import { formatQuoteAmount, formatUsd, shortAddress } from "@/core/format";
import { cn } from "@/lib/cn";
import { useMarket } from "@/lib/market/MarketProvider";
import { CHAIN_NAME, IS_TESTNET } from "@/lib/chain";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { AddressAvatar } from "@/components/ui/AddressAvatar";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Badge, List, ListRow } from "@/components/ui/display";
import { Sheet } from "@/components/ui/Sheet";
import { ThemeSegmented } from "./ThemeSegmented";

const walletButtonWidth = CHAIN_NAME === "Base" ? "w-[164px]" : "w-[216px]";

function useConnectAction() {
  const wallet = useWallet();
  const [canRetry, setCanRetry] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setCanRetry(false);
    if (wallet.status !== "connecting") return;
    const timer = window.setTimeout(() => setCanRetry(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [wallet.status, attempt]);
  const connect = async () => {
    try {
      setCanRetry(false);
      setAttempt((value) => value + 1);
      if (wallet.status === "connecting" && canRetry) await wallet.disconnect();
      await wallet.connect();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Your wallet could not connect. Please try again.");
    }
  };
  return { wallet, connect, canRetry, loading: wallet.status === "connecting" && !canRetry };
}

export function WalletButton({ className }: { className?: string }) {
  const { wallet, connect, canRetry, loading } = useConnectAction();
  const [open, setOpen] = useState(false);

  if (wallet.status !== "connected" || !wallet.address) {
    return (
      <Button
        size="sm"
        variant="filled"
        loading={loading}
        loadingLabel="Connecting"
        onClick={() => void connect()}
        className={cn(walletButtonWidth, "shrink-0", className)}
      >
        {canRetry ? "Retry connection" : "Connect"}
      </Button>
    );
  }

  if (!wallet.onBase) {
    return (
      <Button
        size="sm"
        variant="destructive"
        leading={<TriangleAlert className="size-4" aria-hidden />}
        loading={wallet.isSwitching}
        loadingLabel="Switching"
        onClick={() => {
          wallet.switchToBase().catch((error: unknown) => toast.error(error instanceof Error ? error.message : `Switch to ${CHAIN_NAME} in your wallet.`));
        }}
        className={cn(walletButtonWidth, "shrink-0", className)}
      >
        Switch to {CHAIN_NAME}
      </Button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Account ${shortAddress(wallet.address)}`}
        className={cn(
          walletButtonWidth,
          "relative inline-flex h-[34px] shrink-0 items-center justify-center gap-2 rounded-full bg-fill-3 pl-1 pr-3 text-subhead font-semibold text-label transition-colors hover:bg-fill-2",
          "before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-['']",
          className,
        )}
      >
        <AddressAvatar address={wallet.address} size={26} />
        <span className="mf-num">{shortAddress(wallet.address)}</span>
      </button>
      <AccountSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

function AccountSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const wallet = useWallet();
  const { market } = useMarket();
  if (!wallet.address) return null;
  const address = wallet.address;
  const balances = (market?.listQuotes() ?? []).map((quote) => ({ quote, amount: market?.getQuoteBalance(address, quote.address) ?? 0 })).filter(
    (entry) => entry.amount > 0,
  );
  const totalUsd = balances.reduce((sum, entry) => sum + entry.amount * entry.quote.usdPrice, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Account" hideTitle>
      <div className="flex flex-col items-center gap-2 pb-5 pt-1 text-center">
        <AddressAvatar address={address} size={64} />
        <div className="flex items-center gap-1">
          <span className="mf-num text-headline text-label">{shortAddress(address, 6, 4)}</span>
          <CopyButton value={address} label="Copy address" />
        </div>
        {wallet.mode === "demo" ? <Badge tone="warning">Demo wallet, preview balances</Badge> : <Badge tone="up">Connected on {CHAIN_NAME}</Badge>}
        <p className="mf-num mt-1 text-title2 text-label">{formatUsd(totalUsd)}</p>
      </div>
      <div className="flex flex-col gap-6">
        <List header="Balances">
          {balances.length === 0 ? (
            <ListRow title="No balances" subtitle={IS_TESTNET ? `Get free  ETH from a faucet to start trading.` : "Add ETH on Base to start trading."} />
          ) : (
            balances.map(({ quote, amount }) => (
              <ListRow
                key={quote.symbol}
                title={quote.symbol}
                subtitle={quote.name}
                trailing={
                  <span className="flex flex-col items-end">
                    <span className="mf-num text-body text-label">{formatQuoteAmount(amount, quote.symbol)}</span>
                    <span className="mf-num text-footnote text-label-2">{formatUsd(amount * quote.usdPrice)}</span>
                  </span>
                }
              />
            ))
          )}
        </List>
        <List>
          <ListRow title="Profile" leading={<UserRound className="size-5 text-tint" aria-hidden />} href="/me" chevron />
          <ListRow title="Rewards" leading={<Gift className="size-5 text-tint" aria-hidden />} href="/rewards" chevron />
        </List>
        <div className="flex flex-col gap-2">
          <span className="px-1 text-footnote font-semibold uppercase tracking-wide text-label-2">Appearance</span>
          <ThemeSegmented />
        </div>
        <Button
          variant="destructive"
          size="lg"
          fullWidth
          leading={<LogOut className="size-5" aria-hidden />}
          onClick={() => {
            void wallet.disconnect();
            onOpenChange(false);
          }}
        >
          Disconnect
        </Button>
      </div>
    </Sheet>
  );
}

export function ConnectHint({ action }: { action: string }) {
  const { connect, canRetry, loading } = useConnectAction();
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <p className="text-subhead text-label-2">Connect a wallet to {action}.</p>
      <Button onClick={() => void connect()} loading={loading} loadingLabel="Connecting">
        {canRetry ? "Retry connection" : "Connect wallet"}
      </Button>
      <Link href="/how-it-works" className="text-footnote font-semibold text-tint">
        How memefun works
      </Link>
    </div>
  );
}
