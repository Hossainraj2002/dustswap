"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { launchFeeBps, protectionRemainingSec } from "@/core/antiSnipe";
import { formatBps, formatCoinAmount, formatPercent, formatQuoteAmount, fromUnits } from "@/core/format";
import { COIN_DECIMALS } from "@/core/constants";
import { minOut } from "@/core/pool";
import { cn } from "@/lib/cn";
import { useAnimationNow, useNow } from "@/lib/hooks";
import { useCoinBalance, useQuoteBalance, useTrades } from "@/lib/market/hooks";
import { useMarket } from "@/lib/market/MarketProvider";
import type { Coin } from "@/lib/market/types";
import { CHAIN_NAME, explorerUrl } from "@/lib/chain";
import { TxError, type TxStage } from "@/lib/market/Market";
import { stageLabel } from "@/lib/trade/stages";
import { usePreview } from "@/lib/preview/scenario";
import { useReferrer } from "@/lib/referrals";
import { buyPresets, impactLevel, tradeCta } from "@/lib/trade/cta";
import { autoSlippageBps, CUSTOM_SLIPPAGE_ERROR, resolveSlippageBps, type SlippageSetting } from "@/lib/trade/slippage";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SlippageControl } from "./SlippageControl";

interface TradePanelProps {
  coin: Coin;
  initialSide?: "buy" | "sell";
  onDone?: () => void;
  onPendingChange?: (pending: boolean) => void;
  /** Another trade panel on this screen may already be awaiting the same wallet. */
  locked?: boolean;
  className?: string;
}

function parseAmount(value: string): number {
  const cleaned = value.replace(/,/g, "").trim();
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === "" || cleaned === ".") return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Rounds DOWN, so a filled-in amount never exceeds the balance it came from. */
function trimInput(value: number, decimals = 6) {
  const factor = 10 ** decimals;
  return (Math.floor(value * factor) / factor).toFixed(decimals).replace(/\.?0+$/, "");
}

export function TradePanel({ coin, initialSide = "buy", onDone, onPendingChange, locked = false, className }: TradePanelProps) {
  const amountInputId = useId();
  const wallet = useWallet();
  const { market, version } = useMarket();
  const { txOutcome, stocksRestricted, preview } = usePreview();
  const referrer = useReferrer(wallet.address);
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
  const [amountText, setAmountText] = useState("");
  // "Max" on a sell means the whole balance to the last unit, not the rounded number shown.
  const [maxSell, setMaxSell] = useState(false);
  const [payWithEth, setPayWithEth] = useState(false);
  const [slippage, setSlippage] = useState<SlippageSetting>({ mode: "auto" });
  const [pending, setPending] = useState(false);
  const [walletAction, setWalletAction] = useState<"connect" | "switch" | null>(null);
  const submitting = useRef(false);
  const [submittedLimit, setSubmittedLimit] = useState<{ bps: number; minReceive: number; raw?: string } | null>(null);
  const [stage, setStage] = useState<TxStage | null>(null);

  useEffect(() => setSide(initialSide), [initialSide]);
  useEffect(() => {
    setAmountText("");
    setMaxSell(false);
  }, [side, payWithEth, coin.selectedPoolId, coin.address, coin.quote.address, wallet.address]);
  // Live pairs have no ETH route yet: pay in the pair asset.
  const live = market?.kind === "live";

  const tick = useNow();
  const recentTrades = useTrades(coin.address, 100, coin.selectedPoolId);
  const autoBps = autoSlippageBps({ createdAt: coin.createdAt, liquidityUsd: coin.liquidityUsd, now: tick, trades: recentTrades });
  const slippageBps = pending && submittedLimit ? submittedLimit.bps : resolveSlippageBps(slippage, autoBps);
  const protection = { startBps: coin.terms.snipeStartBps, durationSec: coin.terms.snipeDurationSec };
  const protectionActive = tick > 0 && protectionRemainingSec(coin.createdAt, tick, protection) > 0;
  const smoothNow = useAnimationNow(protectionActive);
  // One clock for everything on the panel, so the banner and the fee line agree.
  const now = protectionActive ? smoothNow : tick;
  const protectionLeft = now > 0 ? protectionRemainingSec(coin.createdAt, now, protection) : 0;

  const routed = !live && side === "buy" && payWithEth && coin.quote.symbol !== "ETH";
  const payingSymbol = side === "sell" ? coin.symbol : routed ? "ETH" : coin.quote.symbol;
  const quoteBalance = useQuoteBalance(wallet.address, routed ? "0x0000000000000000000000000000000000000000" : coin.quote.address);
  const coinBalance = useCoinBalance(wallet.address, coin.address);
  const balance = side === "buy" ? quoteBalance : coinBalance;
  const amount = parseAmount(amountText);

  const quote = useMemo(
    () => (market && amount > 0 ? market.quote(coin.address, side, amount, tick || Date.now(), routed, coin.selectedPoolId) : null),
    // The fee decays with time even when the pool has not changed.
    [market, version, coin.address, coin.priceQuote, coin.selectedPoolId, side, amount, routed, tick], // eslint-disable-line react-hooks/exhaustive-deps
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
    quoteLoading: Boolean(quote && !quote.ok && quote.reason === "Loading the pool."),
    chainName: CHAIN_NAME,
  });

  const outSymbol = side === "buy" ? coin.symbol : coin.quote.symbol;
  // Live quotes carry raw output so the displayed floor survives quote refreshes
  // while the wallet opens, without any floating-point reconstruction.
  const draftMinAmountOutRaw = quote?.amountOutRaw && slippageBps !== null
    ? minOut(BigInt(quote.amountOutRaw), slippageBps).toString() : undefined;
  const draftMinReceive = draftMinAmountOutRaw !== undefined
    ? fromUnits(BigInt(draftMinAmountOutRaw), side === "buy" ? COIN_DECIMALS : coin.quote.decimals)
    : quote && slippageBps !== null ? quote.amountOut * (1 - slippageBps / 10_000) : 0;
  const minAmountOutRaw = pending && submittedLimit ? submittedLimit.raw : draftMinAmountOutRaw;
  const minReceive = pending && submittedLimit ? submittedLimit.minReceive : draftMinReceive;
  const invalidSlippage = slippageBps === null;
  const zeroMinimum = quote?.ok && minReceive <= 0;
  const impact = quote ? impactLevel(quote.priceImpact) : "none";
  const walletBusy = walletAction !== null || wallet.status === "connecting" || wallet.isSwitching;

  const submit = async () => {
    if (locked || pending || submitting.current || walletBusy) return;
    if (cta.kind === "connect") {
      submitting.current = true;
      setWalletAction("connect");
      try {
        await wallet.connect();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not connect your wallet. Try again.");
      } finally {
        submitting.current = false;
        setWalletAction(null);
      }
      return;
    }
    if (cta.kind === "switch") {
      submitting.current = true;
      setWalletAction("switch");
      try {
        await wallet.switchToBase();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Switch to ${CHAIN_NAME} in your wallet.`);
      } finally {
        submitting.current = false;
        setWalletAction(null);
      }
      return;
    }
    if (cta.kind !== "ready" || !market || !wallet.address || !quote || slippageBps === null || zeroMinimum) return;
    submitting.current = true;
    setSubmittedLimit({ bps: slippageBps, minReceive, raw: minAmountOutRaw });
    setPending(true);
    onPendingChange?.(true);
    try {
      const trade = await market.trade(wallet.address, coin.address, side, amount, minReceive, {
        poolId: coin.selectedPoolId,
        outcome: txOutcome,
        referrer,
        payWithEth: routed,
        amountText: amountText.replace(/,/g, "").trim(),
        max: side === "sell" && maxSell,
        slippageBps,
        minAmountOutRaw,
        onStage: setStage,
      });
      const txUrl = preview ? null : explorerUrl("tx", trade.txHash);
      const verb = side === "buy" ? "Bought" : "Sold";
      toast.success(
        side === "buy"
          ? `${verb} ${formatCoinAmount(trade.coinAmount)} ${coin.symbol}`
          : `${verb} ${formatCoinAmount(trade.coinAmount)} ${coin.symbol} for ${formatQuoteAmount(trade.quoteAmount, coin.quote.symbol)}`,
        {
          description: preview ? "Preview trade. Nothing was sent on chain." : undefined,
          ...(txUrl ? { action: { label: "View", onClick: () => window.open(txUrl, "_blank", "noopener,noreferrer") } } : {}),
        },
      );
      setAmountText("");
      setMaxSell(false);
      onDone?.();
    } catch (error) {
      if (error instanceof TxError && error.kind === "rejected") toast("Trade cancelled", { description: error.message });
      else toast.error("Trade did not go through", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      submitting.current = false;
      setPending(false);
      onPendingChange?.(false);
      setSubmittedLimit(null);
      setStage(null);
    }
  };

  const presets = side === "buy" ? buyPresets(payingSymbol, routed ? "native" : coin.quote.kind) : [0.25, 0.5, 0.75, 1];

  return (
    <fieldset disabled={pending || locked} className={cn("flex min-w-0 flex-col gap-4", className)}>
      <p className="text-footnote text-label-2">Trading {coin.symbol} / {coin.quote.symbol}. Token balances are shared across all pools.</p>
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
        <SlippageControl value={slippage} autoBps={pending && submittedLimit ? submittedLimit.bps : autoBps} onChange={setSlippage} disabled={pending || locked} />
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
          <label htmlFor={amountInputId}>You pay</label>
          {wallet.status === "connected" ? (
            <button
              type="button"
              className="mf-num font-semibold text-tint"
              onClick={() => {
                setAmountText(trimInput(side === "buy" && payingSymbol === "ETH" ? Math.max(0, balance - 0.0005) : balance));
                setMaxSell(side === "sell");
              }}
            >
              Balance {side === "buy" ? formatQuoteAmount(balance, payingSymbol) : `${formatCoinAmount(balance)} ${coin.symbol}`}
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <input
            id={amountInputId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={amountText}
            onChange={(event) => {
              const next = event.target.value.replace(",", ".");
              if (/^\d*\.?\d*$/.test(next) && next.length <= 24) {
                setAmountText(next);
                setMaxSell(false);
              }
            }}
            className="mf-num min-w-0 flex-1 bg-transparent text-title1 font-bold text-label outline-none placeholder:text-label-3"
          />
          {side === "buy" && coin.quote.symbol !== "ETH" && !live ? (
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
              onClick={() => {
                setAmountText(trimInput(side === "buy" ? preset : balance * preset));
                setMaxSell(side === "sell" && preset === 1);
              }}
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
            <dt className="text-label-2">{slippageBps === null ? "Minimum received" : `At least, after ${formatBps(slippageBps)} slippage${slippage.mode === "auto" ? " (Auto)" : ""}`}</dt>
            <dd className="mf-num text-label">
              {invalidSlippage ? "Set slippage" : side === "buy" ? `${formatCoinAmount(minReceive)} ${outSymbol}` : formatQuoteAmount(minReceive, outSymbol)}
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

      {invalidSlippage ? <p role="alert" className="text-footnote text-down">{CUSTOM_SLIPPAGE_ERROR}</p> : zeroMinimum ? <p role="alert" className="text-footnote text-down">This amount is too small to set a protected minimum. Increase the amount.</p> : null}

      <Button
        size="lg"
        fullWidth
        variant={cta.kind === "ready" || cta.kind === "pending" ? (side === "buy" ? "buy" : "sell") : cta.kind === "switch" ? "destructive" : "filled"}
        disabled={(!cta.enabled && cta.kind !== "pending") || (cta.kind === "ready" && (invalidSlippage || Boolean(zeroMinimum)))}
        loading={pending || walletBusy}
        loadingLabel={pending ? stageLabel(stage, { token: payingSymbol, chainName: CHAIN_NAME })
          : walletAction === "switch" || wallet.isSwitching ? `Switching to ${CHAIN_NAME}` : "Connecting"}
        onClick={() => void submit()}
      >
        {cta.kind === "ready" && invalidSlippage ? "Set valid slippage" : cta.kind === "ready" && zeroMinimum ? "Amount too small" : cta.label}
      </Button>
    </fieldset>
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

