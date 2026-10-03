"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Settings2, ShieldAlert } from "lucide-react";
import { launchFeeBps, protectionRemainingSec } from "@/core/antiSnipe";
import { formatBps, formatCoinAmount, formatPercent, formatQuoteAmount } from "@/core/format";
import { cn } from "@/lib/cn";
import { useAnimationNow, useNow } from "@/lib/hooks";
import { useCoinBalance, useQuoteBalance } from "@/lib/market/hooks";
import { useMarket } from "@/lib/market/MarketProvider";
import type { Coin } from "@/lib/market/types";
import { PreviewTxError } from "@/lib/preview/engine";
import { usePreview } from "@/lib/preview/scenario";
import { useReferrer } from "@/lib/referrals";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, SLIPPAGE_PRESETS_BPS, buyPresets, impactLevel, tradeCta } from "@/lib/trade/cta";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { Button } from "@/components/ui/Button";
import { FeeSplitBar } from "@/components/ui/FeeSplitBar";
import { Popover } from "@/components/ui/Popover";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

interface TradePanelProps {
  coin: Coin;
  initialSide?: "buy" | "sell";
  onDone?: () => void;
  className?: string;
}

function parseAmount(value: string): number {
  const cleaned = value.replace(/,/g, "").trim();
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === "" || cleaned === ".") return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function trimInput(value: number, decimals = 6) {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

export function TradePanel({ coin, initialSide = "buy", onDone, className }: TradePanelProps) {
  const wallet = useWallet();
  const { market } = useMarket();
  const { txOutcome, stocksRestricted, preview } = usePreview();
  const referrer = useReferrer(wallet.address);
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
  const [amountText, setAmountText] = useState("");
  const [payWithEth, setPayWithEth] = useState(false);
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [pending, setPending] = useState(false);
  const [showFees, setShowFees] = useState(false);

  useEffect(() => setSide(initialSide), [initialSide]);
  useEffect(() => setAmountText(""), [side, payWithEth]);

  const tick = useNow();
  const protection = { startBps: coin.terms.snipeStartBps, durationSec: coin.terms.snipeDurationSec };
  const protectionActive = tick > 0 && protectionRemainingSec(coin.createdAt, tick, protection) > 0;
  const smoothNow = useAnimationNow(protectionActive);
  // One clock for everything on the panel, so the banner and the fee line agree.
  const now = protectionActive ? smoothNow : tick;
  const protectionLeft = now > 0 ? protectionRemainingSec(coin.createdAt, now, protection) : 0;

  const routed = side === "buy" && payWithEth && coin.quote.symbol !== "ETH";
  const payingSymbol = side === "sell" ? coin.symbol : routed ? "ETH" : coin.quote.symbol;
  const quoteBalance = useQuoteBalance(wallet.address, routed ? "ETH" : coin.quote.symbol);
  const coinBalance = useCoinBalance(wallet.address, coin.address);
  const balance = side === "buy" ? quoteBalance : coinBalance;
  const amount = parseAmount(amountText);

  const quote = useMemo(
    () => (market && amount > 0 ? market.quote(coin.address, side, amount, Date.now(), routed) : null),
    // Re-quote whenever the coin's price moves.
    [market, coin.address, coin.priceQuote, side, amount, routed], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const restricted = stocksRestricted && coin.quote.kind === "stock";
  const cta = tradeCta({
    connected: wallet.status === "connected",
    onBase: wallet.onBase,
    side,
    amount,
    balance,
    payingSymbol,
    coinSymbol: coin.symbol,
    restricted,
    pending,
    quoteOk: quote ? quote.ok : true,
  });

  const outSymbol = side === "buy" ? coin.symbol : coin.quote.symbol;
  const minReceive = quote ? quote.amountOut * (1 - slippageBps / 10_000) : 0;
  const impact = quote ? impactLevel(quote.priceImpact) : "none";
  const feeNow = launchFeeBps(coin.terms.feeBps, protection, now > 0 ? (now - coin.createdAt) / 1000 : 0);

  const submit = async () => {
    if (cta.kind === "connect") return void wallet.connect();
    if (cta.kind === "switch") {
      try {
        await wallet.switchToBase();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Switch to Base in your wallet.");
      }
      return;
    }
    if (cta.kind !== "ready" || !market || !wallet.address || !quote) return;
    setPending(true);
    try {
      const trade = await market.trade(wallet.address, coin.address, side, amount, minReceive, {
        outcome: txOutcome,
        referrer,
        payWithEth: routed,
      });
      const verb = side === "buy" ? "Bought" : "Sold";
      toast.success(
        side === "buy"
          ? `${verb} ${formatCoinAmount(trade.coinAmount)} ${coin.symbol}`
          : `${verb} ${formatCoinAmount(trade.coinAmount)} ${coin.symbol} for ${formatQuoteAmount(trade.quoteAmount, coin.quote.symbol)}`,
        { description: preview ? "Preview trade. Nothing was sent on chain." : undefined },
      );
      setAmountText("");
      onDone?.();
    } catch (error) {
      if (error instanceof PreviewTxError && error.kind === "rejected") toast("Trade cancelled", { description: error.message });
      else toast.error("Trade did not go through", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setPending(false);
    }
  };

  const presets = side === "buy" ? buyPresets(payingSymbol, routed ? "native" : coin.quote.kind) : [0.25, 0.5, 0.75, 1];

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center gap-2">
        <SegmentedControl
          label="Trade side"
          fullWidth
          value={side}
          onChange={setSide}
          segments={[
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
          ]}
          selectedClassName={(value) => (value === "buy" ? "bg-up-fill!" : "bg-down-fill!")}
          className="flex-1 [&_[aria-checked=true]]:text-on-tint"
        />
        <SlippageButton value={slippageBps} onChange={setSlippageBps} />
      </div>

      {protectionLeft > 0 ? (
        <ProtectionBanner
          remaining={protectionLeft}
          duration={protection.durationSec}
          feeBps={launchFeeBps(coin.terms.feeBps, protection, (now - coin.createdAt) / 1000)}
          normalBps={coin.terms.feeBps}
        />
      ) : null}

      <div className="flex flex-col gap-2 rounded-lg bg-fill-4 p-4">
        <div className="flex items-center justify-between text-footnote text-label-2">
          <label htmlFor={`amount-${coin.address}`}>You pay</label>
          {wallet.status === "connected" ? (
            <button
              type="button"
              className="mf-num font-semibold text-tint"
              onClick={() => setAmountText(trimInput(side === "buy" && payingSymbol === "ETH" ? Math.max(0, balance - 0.0005) : balance))}
            >
              Balance {side === "buy" ? formatQuoteAmount(balance, payingSymbol) : `${formatCoinAmount(balance)} ${coin.symbol}`}
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <input
            id={`amount-${coin.address}`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={amountText}
            onChange={(event) => {
              const next = event.target.value.replace(",", ".");
              if (/^\d*\.?\d*$/.test(next) && next.length <= 24) setAmountText(next);
            }}
            className="mf-num min-w-0 flex-1 bg-transparent text-title1 font-bold text-label outline-none placeholder:text-label-3"
          />
          {side === "buy" && coin.quote.symbol !== "ETH" ? (
            <SegmentedControl
              label="Pay with"
              size="sm"
              value={payWithEth ? "eth" : "quote"}
              onChange={(value) => setPayWithEth(value === "eth")}
              segments={[
                { value: "quote", label: coin.quote.symbol },
                { value: "eth", label: "ETH" },
              ]}
            />
          ) : (
            <span className="rounded-full bg-fill-3 px-3 py-1.5 text-subhead font-semibold text-label">{payingSymbol}</span>
          )}
        </div>
        {/* Four equal chips always fit, even in the narrow desktop column. The
            field already names the asset, so buy chips show just the amount. */}
        <div className="grid grid-cols-4 gap-1.5 pt-1">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-label={
                side === "buy" ? `Pay ${preset} ${payingSymbol}` : preset === 1 ? "Max, sell your whole balance" : `Sell ${preset * 100}% of your balance`
              }
              onClick={() => setAmountText(trimInput(side === "buy" ? preset : balance * preset))}
              className="relative h-8 min-w-0 rounded-full bg-fill-3 px-2 text-footnote font-semibold text-label transition-colors hover:bg-fill-2 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']"
            >
              {side === "buy" ? String(preset) : preset === 1 ? "Max" : `${preset * 100}%`}
            </button>
          ))}
        </div>
      </div>

      {quote && amount > 0 ? (
        <dl className="flex flex-col gap-2 px-1 text-subhead">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-label-2">You receive</dt>
            <dd className="mf-num text-headline text-label">
              {side === "buy" ? `${formatCoinAmount(quote.amountOut)} ${outSymbol}` : formatQuoteAmount(quote.amountOut, outSymbol)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-label-2">At least, after {formatBps(slippageBps)} slippage</dt>
            <dd className="mf-num text-label">
              {side === "buy" ? `${formatCoinAmount(minReceive)} ${outSymbol}` : formatQuoteAmount(minReceive, outSymbol)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-label-2">Price impact</dt>
            <dd className={cn("mf-num font-semibold", impact === "high" ? "text-down" : impact === "notice" ? "text-warning" : "text-label")}>
              {formatPercent(quote.priceImpact)}
            </dd>
          </div>
          {routed && quote.routedQuoteIn ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-label-2">Route</dt>
              <dd className="flex items-center gap-1 text-label">
                ETH <ChevronRight className="size-3.5 text-label-3" aria-label="then" /> {formatQuoteAmount(quote.routedQuoteIn, coin.quote.symbol)}
                <ChevronRight className="size-3.5 text-label-3" aria-label="then" /> {coin.symbol}
              </dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-label-2">Trading fee</dt>
            <dd className="mf-num text-label">
              {formatBps(quote.feeBps)} ({formatQuoteAmount(quote.feeQuote, coin.quote.symbol)})
            </dd>
          </div>
          {impact !== "none" ? (
            <p className={cn("rounded-md px-3 py-2 text-footnote", impact === "high" ? "bg-down/10 text-down" : "bg-warning/10 text-warning")} role="status">
              {impact === "high"
                ? "This trade moves the price a lot. You will get much less than the current price suggests. Consider a smaller amount."
                : "This trade moves the price noticeably. A smaller amount gets a better average price."}
            </p>
          ) : null}
        </dl>
      ) : null}

      {restricted ? (
        <p className="rounded-md bg-fill-4 px-3 py-2 text-footnote text-label-2">
          Coins paired with tokenized stocks are not available in your region. Coinbase tokenized stocks are only offered outside the United States.
        </p>
      ) : null}

      <Button
        size="lg"
        fullWidth
        variant={cta.kind === "ready" || cta.kind === "pending" ? (side === "buy" ? "buy" : "sell") : cta.kind === "switch" ? "destructive" : "filled"}
        disabled={!cta.enabled && cta.kind !== "pending"}
        loading={pending}
        loadingLabel="Confirm in your wallet"
        onClick={() => void submit()}
      >
        {cta.label}
      </Button>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          aria-expanded={showFees}
          onClick={() => setShowFees((open) => !open)}
          className="flex items-center justify-between rounded-md px-1 py-1 text-footnote text-label-2 transition-colors hover:text-label"
        >
          <span>
            Fee is {formatBps(feeNow)} of every trade, paid in {coin.quote.symbol}
            {feeNow !== coin.terms.feeBps ? ` (normally ${formatBps(coin.terms.feeBps)})` : ""}
          </span>
          <ChevronDown className={cn("size-4 transition-transform", showFees && "rotate-180")} aria-hidden />
        </button>
        {showFees ? (
          <div className="rounded-lg bg-fill-4 p-4">
            <FeeSplitBar
              config={{ mode: coin.terms.mode, platformShareBps: coin.terms.platformShareBps, referralShareBps: coin.terms.referralShareBps, creatorKeepBps: coin.terms.creatorKeepBps }}
              hasReferrer={Boolean(referrer)}
              feeBps={coin.terms.feeBps}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProtectionBanner({ remaining, duration, feeBps, normalBps }: { remaining: number; duration: number; feeBps: number; normalBps: number }) {
  const fraction = duration > 0 ? remaining / duration : 0;
  const size = 36;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="flex items-center gap-3 rounded-lg bg-warning/10 p-3" role="status" aria-live="off">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-warning/20" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className="stroke-warning-ring"
        />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-subhead font-semibold text-warning">
          <ShieldAlert className="size-4" aria-hidden />
          Launch protection: {formatBps(feeBps)} fee
        </p>
        <p className="mf-num text-footnote text-label-2">
          Drops to {formatBps(normalBps)} in {Math.ceil(remaining)}s. Waiting costs less.
        </p>
      </div>
    </div>
  );
}

function SlippageButton({ value, onChange }: { value: number; onChange: (bps: number) => void }) {
  const [custom, setCustom] = useState("");
  return (
    <Popover
      label="Slippage"
      align="end"
      trigger={
        <button
          type="button"
          aria-label={`Slippage ${formatBps(value)}. Change`}
          className="relative inline-flex h-9 shrink-0 items-center gap-1 rounded-[10px] bg-fill-3 px-2.5 text-footnote font-semibold text-label-2 transition-colors hover:text-label before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
        >
          <Settings2 className="size-4" aria-hidden />
          {formatBps(value)}
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-headline text-label">Slippage</p>
          <p className="text-footnote text-label-2">If the price moves more than this before your trade lands, the trade is cancelled and you only pay the network fee.</p>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {SLIPPAGE_PRESETS_BPS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={value === preset}
              onClick={() => onChange(preset)}
              className={cn("h-9 rounded-[10px] text-footnote font-semibold transition-colors", value === preset ? "bg-tint-fill text-on-tint" : "bg-fill-3 text-label hover:bg-fill-2")}
            >
              {formatBps(preset)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-footnote text-label-2">
          Custom
          <input
            inputMode="decimal"
            value={custom}
            placeholder="3"
            onChange={(event) => {
              const next = event.target.value;
              if (!/^\d*\.?\d*$/.test(next)) return;
              setCustom(next);
              const bps = Math.round(Number(next) * 100);
              if (bps > 0 && bps <= MAX_SLIPPAGE_BPS) onChange(bps);
            }}
            className="mf-num h-9 w-20 rounded-[10px] bg-fill-3 px-2 text-subhead text-label outline-none focus:shadow-[0_0_0_2px_var(--mf-tint)]"
          />
          %
        </label>
        {value > 500 ? <p className="text-footnote text-warning">High slippage can give you a much worse price.</p> : null}
      </div>
    </Popover>
  );
}

