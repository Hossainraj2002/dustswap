"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, PauseCircle } from "lucide-react";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { normalizeTicker, validateDescription, validateName, validateTelegram, validateWebsite, validateXHandle } from "@/core/validation";
import { cn } from "@/lib/cn";
import { useIsRegularWidth } from "@/lib/hooks";
import { useLaunchSettings, useQuoteAssets, useQuoteBalance } from "@/lib/market/hooks";
import { useMarket } from "@/lib/market/MarketProvider";
import { ETH } from "@/lib/market/quotes";
import { TxError, type TxStage } from "@/lib/market/Market";
import { CHAIN_NAME } from "@/lib/chain";
import { stageLabel } from "@/lib/trade/stages";
import type { Coin } from "@/lib/market/types";
import { clearDraft, EMPTY_DRAFT, loadDraft, saveDraft, STEPS, validateCoinStep, validateFeesStep, type CreateDraft, type DraftErrors, type StepId } from "@/lib/create/draft";
import { usePreview } from "@/lib/preview/scenario";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { CoinStep } from "./CoinStep";
import { FeesStep } from "./FeesStep";
import { FirstBuyStep } from "./FirstBuyStep";
import { LaunchSuccess } from "./LaunchSuccess";
import { PairStep } from "./PairStep";
import { PreviewCard } from "./PreviewCard";
import { ReviewStep } from "./ReviewStep";
import { Stepper } from "./Stepper";

export function CreateScreen() {
  const settings = useLaunchSettings() ?? DEFAULT_SETTINGS;
  const wallet = useWallet();
  const { market } = useMarket();
  const { txOutcome, stocksRestricted, preview } = usePreview();
  const regular = useIsRegularWidth();
  const [draft, setDraft] = useState<CreateDraft>({ ...EMPTY_DRAFT, feeBps: DEFAULT_SETTINGS.defaultFeeBps });
  const [loaded, setLoaded] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [stage, setStage] = useState<"idle" | TxStage>("idle");
  const [launched, setLaunched] = useState<Coin | null>(null);
  const top = useRef<HTMLDivElement>(null);

  // Restore an unfinished draft after mount (never during render: hydration).
  useEffect(() => {
    const saved = loadDraft();
    if (saved) setDraft(saved);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded && !launched) saveDraft(draft);
  }, [draft, loaded, launched]);

  const step: StepId = STEPS[stepIndex]?.id ?? "coin";
  const quotes = useQuoteAssets();
  const quote = quotes.find((entry) => entry.symbol === draft.quoteSymbol) ?? quotes[0] ?? ETH;
  // A draft saved against assets this market does not list (another network, a delisted stock)
  // falls back to the first available one.
  useEffect(() => {
    if (quotes.length > 0 && !quotes.some((entry) => entry.symbol === draft.quoteSymbol)) {
      setDraft((current) => ({ ...current, quoteSymbol: quotes[0]!.symbol }));
    }
  }, [quotes, draft.quoteSymbol]);
  const quoteBalance = useQuoteBalance(wallet.address, quote.symbol);
  const update = (patch: Partial<CreateDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const errors: DraftErrors = useMemo(() => {
    switch (step) {
      case "coin":
        return validateCoinStep(draft);
      case "pair":
        if (stocksRestricted && quote.kind === "stock") return { quoteSymbol: "Stock pairs are not available in your region." };
        if (!settings.enabledQuoteKinds.includes(quote.kind)) return { quoteSymbol: "This pair is not available right now. Choose another." };
        return {};
      case "fees":
        return validateFeesStep(draft, settings);
      case "buy": {
        const amount = Number(draft.firstBuy) || 0;
        if (amount < 0 || Number.isNaN(Number(draft.firstBuy || "0"))) return { firstBuy: "Enter a valid amount." };
        if (wallet.status === "connected" && amount > quoteBalance) return { firstBuy: `Not enough ${quote.symbol}.` };
        return {};
      }
      default:
        return {};
    }
  }, [draft, quote.kind, quote.symbol, quoteBalance, settings, step, stocksRestricted, wallet.status]);

  const goTo = (index: number) => {
    setStepIndex(index);
    setFurthest((current) => Math.max(current, index));
    setShowErrors(false);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const next = () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      toast.error("Check the highlighted fields", { description: Object.values(errors)[0] });
      return;
    }
    goTo(Math.min(stepIndex + 1, STEPS.length - 1));
  };

  const launch = async () => {
    if (wallet.status !== "connected" || !wallet.address) return void wallet.connect();
    if (!wallet.onBase) {
      try {
        await wallet.switchToBase();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Switch to ${CHAIN_NAME} in your wallet.`);
      }
      return;
    }
    if (!market) return;
    // Re-check everything at launch time; earlier steps may have been edited.
    const blocking = { ...validateCoinStep(draft), ...validateFeesStep(draft, settings) };
    if (Object.keys(blocking).length > 0) {
      toast.error("Some details need fixing", { description: Object.values(blocking)[0] });
      goTo(blocking.feeBps || blocking.mode || blocking.creatorKeepBps ? 2 : 0);
      return;
    }
    setStage("confirm");
    // Preview has no wallet steps to report, so it shows the confirm then the launch step.
    const chainTimer = market.kind === "preview" ? window.setTimeout(() => setStage("pending"), 700) : undefined;
    try {
      const coin = await market.launch(
        wallet.address,
        {
          name: validateName(draft.name).value,
          symbol: normalizeTicker(draft.ticker),
          description: validateDescription(draft.description).value,
          image: draft.image ?? "",
          links: {
            x: validateXHandle(draft.x).value || undefined,
            telegram: validateTelegram(draft.telegram).value || undefined,
            website: validateWebsite(draft.website).value || undefined,
          },
          quote,
          feeBps: draft.feeBps,
          mode: draft.mode,
          creatorKeepBps: draft.mode === "creator" ? 0 : draft.creatorKeepBps,
          firstBuyQuote: Number(draft.firstBuy) || 0,
          firstBuyText: draft.firstBuy,
        },
        txOutcome,
        setStage,
      );
      clearDraft();
      setLaunched(coin);
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof TxError && error.kind === "rejected") toast("Launch cancelled", { description: error.message });
      else toast.error("Launch did not go through", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      if (chainTimer !== undefined) window.clearTimeout(chainTimer);
      setStage("idle");
    }
  };

  if (launched) {
    return (
      <LaunchSuccess
        coin={launched}
        onLaunchAnother={() => {
          setLaunched(null);
          setDraft({ ...EMPTY_DRAFT, feeBps: settings.defaultFeeBps });
          goTo(0);
          setFurthest(0);
        }}
      />
    );
  }

  const launching = stage !== "idle";
  const launchLabel =
    wallet.status !== "connected"
      ? "Connect wallet to launch"
      : !wallet.onBase
        ? `Switch to ${CHAIN_NAME}`
        : stage !== "idle"
          ? stageLabel(stage, { token: quote.symbol, chainName: CHAIN_NAME, pending: `Launching on ${CHAIN_NAME}` })
          : `Launch ${normalizeTicker(draft.ticker) || "coin"}`;

  const actions = (
    <div className="flex gap-3">
      {stepIndex > 0 ? (
        <Button variant="gray" size="lg" onClick={() => goTo(stepIndex - 1)} disabled={launching} className={cn(regular ? "" : "flex-1")}>
          Back
        </Button>
      ) : null}
      {step === "review" ? (
        <Button size="lg" className="flex-[2]" onClick={() => void launch()} loading={launching} loadingLabel={launchLabel} disabled={settings.launchesPaused}>
          {launchLabel}
        </Button>
      ) : (
        <Button size="lg" className="flex-[2]" onClick={next}>
          Continue
        </Button>
      )}
    </div>
  );

  return (
    <>
      <div ref={top} className="scroll-mt-4" />
      <PageHeader
        title="Create a coin"
        subtitle="One transaction. Fixed supply, no admin keys, liquidity locked forever."
        leading={
          <Link href="/" className="inline-flex h-11 items-center gap-0.5 text-body text-tint">
            <ChevronLeft className="size-6" aria-hidden />
            Cancel
          </Link>
        }
      />
      <div className="mb-5">
        <Stepper current={step} furthest={furthest} onSelect={(id) => goTo(STEPS.findIndex((entry) => entry.id === id))} />
      </div>

      {settings.launchesPaused ? (
        <div className="mb-5 flex gap-3 rounded-lg bg-warning/10 p-4" role="status">
          <PauseCircle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
          <p className="text-subhead text-label">New launches are paused for now. Existing coins keep trading as normal. You can still prepare your coin.</p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section aria-label={STEPS[stepIndex]?.label} className="mf-card p-5 sm:p-6">
            <h2 className="mb-5 text-title2 text-label">{stepTitle(step)}</h2>
            {step === "coin" ? <CoinStep draft={draft} update={update} errors={errors} showErrors={showErrors} /> : null}
            {step === "pair" ? <PairStep draft={draft} update={update} openingFdvUsd={settings.openingFdvUsd} enabledKinds={settings.enabledQuoteKinds} quotes={quotes} /> : null}
            {step === "fees" ? <FeesStep draft={draft} update={update} settings={settings} errors={errors} showErrors={showErrors} /> : null}
            {step === "buy" ? <FirstBuyStep draft={draft} update={update} quote={quote} openingFdvUsd={settings.openingFdvUsd} /> : null}
            {step === "review" ? <ReviewStep draft={draft} quote={quote} settings={settings} /> : null}
          </section>
          {regular ? actions : null}
          {!regular && step !== "review" ? <PreviewCard draft={draft} openingFdvUsd={settings.openingFdvUsd} /> : null}
          {preview && step === "review" ? (
            <p className="px-1 text-footnote text-label-2">Preview: launching creates the coin in the simulated market only.</p>
          ) : null}
        </div>
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <PreviewCard draft={draft} openingFdvUsd={settings.openingFdvUsd} />
          </div>
        </aside>
      </div>

      {!regular ? (
        <div className="fixed inset-x-3 z-40" style={{ bottom: "max(12px, calc(var(--mf-safe-bottom) + 4px))" }}>
          <div className="mf-glass mf-glass-dense mx-auto max-w-md rounded-[28px] p-2">{actions}</div>
        </div>
      ) : null}
    </>
  );
}

function stepTitle(step: StepId): string {
  switch (step) {
    case "coin":
      return "Name your coin";
    case "pair":
      return "Choose its pair";
    case "fees":
      return "Set the fee and where it goes";
    case "buy":
      return "Make the first buy";
    case "review":
      return "Review and launch";
  }
}
