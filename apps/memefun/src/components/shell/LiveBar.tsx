"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, ChevronRight, Droplet, TriangleAlert, WifiOff } from "lucide-react";
import { CHAIN_NAME, IS_TESTNET } from "@/lib/chain";
import { useMarketStatus } from "@/lib/market/hooks";
import { TxError } from "@/lib/market/Market";
import { useLiveMarket } from "@/lib/market/MarketProvider";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";

/**
 * Live mode's counterpart to the preview bar: on a testnet it says so and hands out test funds,
 * and anywhere it reports when live data is unreachable or the app is misconfigured.
 */
export function LiveBar() {
  const live = useLiveMarket();
  const status = useMarketStatus();
  if (!live) return null;
  return (
    <>
      {status.state === "misconfigured" ? (
        <p role="alert" className="flex items-center gap-2 bg-down/10 px-4 py-2 text-footnote text-label lg:rounded-md">
          <TriangleAlert className="size-4 shrink-0 text-down" aria-hidden />
          <span>
            <span className="font-semibold">Trading is off.</span> {status.message} Nothing can be sent until it is fixed.
          </span>
        </p>
      ) : status.state === "offline" ? (
        <p role="status" className="flex items-center gap-2 bg-warning/10 px-4 py-2 text-footnote text-label lg:rounded-md">
          <WifiOff className="size-4 shrink-0 text-warning" aria-hidden />
          <span>
            <span className="font-semibold">Live data is not reachable right now.</span> Prices may be out of date. Retrying on its own.
          </span>
        </p>
      ) : null}
      {IS_TESTNET ? <TestnetBar /> : null}
    </>
  );
}

const FAUCETS = [
  { label: "Coinbase faucet", href: "https://portal.cdp.coinbase.com/products/faucet" },
  { label: "Alchemy faucet", href: "https://www.alchemy.com/faucets/base-sepolia" },
];

function TestnetBar() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 bg-tint/8 px-4 py-2 text-left text-footnote text-label transition-colors hover:bg-tint/12 lg:rounded-md"
      >
        <Droplet className="size-4 shrink-0 text-tint" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">Testnet.</span> Everything here runs on {CHAIN_NAME} and has no real value.
        </span>
        <span className="flex shrink-0 items-center gap-0.5 font-semibold text-label">
          Get test funds
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Test funds" description={`Everything on ${CHAIN_NAME} is free. Get some to try trading and launching.`}>
        <div className="mf-card overflow-hidden bg-bg-elevated-2 [&>*+*]:hairline-t">
          <FundRow title={`${CHAIN_NAME} ETH`} subtitle="Pays network fees and buys ETH-paired coins.">
            <div className="flex flex-wrap gap-2">
              {FAUCETS.map((faucet) => (
                <ExternalLink key={faucet.href} href={faucet.href} label={faucet.label} />
              ))}
            </div>
          </FundRow>
          <FundRow title="Test USDC" subtitle={`For USDC pairs. Choose ${CHAIN_NAME} on Circle's faucet.`}>
            <ExternalLink href="https://faucet.circle.com" label="Circle faucet" />
          </FundRow>
          <StockFaucetRow />
        </div>
      </Sheet>
    </>
  );
}

function FundRow({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div>
        <p className="text-body font-semibold text-label">{title}</p>
        <p className="text-footnote text-label-2">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-9 items-center gap-1 rounded-full bg-fill-3 px-3.5 text-subhead font-semibold text-tint transition-colors hover:bg-fill-2"
    >
      {label}
      <ArrowUpRight className="size-4" aria-hidden />
    </a>
  );
}

function StockFaucetRow() {
  const live = useLiveMarket();
  const wallet = useWallet();
  const [pending, setPending] = useState(false);
  if (!live?.hasTestStockFaucet()) return null;
  const symbol = live.listQuotes().find((quote) => quote.kind === "stock")?.symbol ?? "test stock";

  const drip = async () => {
    if (!wallet.address) return void wallet.connect();
    setPending(true);
    try {
      await live.dripTestStock(wallet.address);
      toast.success(`10 ${symbol} sent to your wallet`);
    } catch (error) {
      if (error instanceof TxError && error.kind === "rejected") toast("Cancelled", { description: error.message });
      else toast.error("The faucet did not send anything", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setPending(false);
    }
  };

  return (
    <FundRow title={`Test stock (${symbol})`} subtitle="For stock pairs. 10 per wallet per day, free.">
      <Button size="sm" variant="tinted" className="self-start" loading={pending} loadingLabel="Confirm in your wallet" onClick={() => void drip()}>
        {wallet.address ? `Get 10 ${symbol}` : "Connect wallet"}
      </Button>
    </FundRow>
  );
}
