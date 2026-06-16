"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

const GUIDE_HIDDEN_KEY = "dustsweep:guide:never";

const SUPPORTED_WALLETS = [
  { name: "Base App", logo: "/wallets/base.png" },
  { name: "Coinbase", logo: "/wallets/coinbase.png" },
  { name: "OKX", logo: "/wallets/okx.png" },
  { name: "Ambire", logo: "/wallets/ambire.png" },
  { name: "TokenPocket", logo: "/wallets/tokenpocket.png" },
  { name: "MetaMask", logo: "/wallets/metamask.png" },
] as const;

function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 sm:h-5 sm:w-5">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.5-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 sm:h-5 sm:w-5">
      <circle cx="6" cy="19" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="5" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8.5 19H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 sm:h-5 sm:w-5">
      <path
        d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 sm:h-5 sm:w-5">
      <path
        d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8 7.5 10 4.3-2 7.5-5.4 7.5-10v-6L12 2.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path d="m8.8 11.8 2.2 2.2 4.2-4.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function StepRow({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-[8px] border border-slate-100 bg-slate-50 px-2.5 py-2 text-left sm:gap-3 sm:px-3.5 sm:py-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-blue-600/10 text-blue-600 sm:h-9 sm:w-9">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-bold text-slate-900 sm:text-sm">{title}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500 sm:text-[13px]">{description}</p>
      </div>
    </div>
  );
}

function GuideStepOne() {
  return (
    <div>
      <h2 className="text-[17px] font-bold text-slate-950 sm:text-xl">
        Sweep your dust in one click
      </h2>
      <p className="mt-1.5 text-[12px] leading-snug text-slate-500 sm:mt-2 sm:text-sm sm:leading-relaxed">
        DustSweep turns the small leftover tokens in your wallet into one token you actually want
        &mdash; all on Base, all in a single flow.
      </p>
      <div className="mt-3.5 space-y-1.5 sm:mt-5 sm:space-y-2.5">
        <StepRow
          icon={<ScanIcon />}
          title="Discover"
          description="We scan your wallet and surface every token balance worth sweeping."
        />
        <StepRow
          icon={<RouteIcon />}
          title="Route"
          description="Each token gets its own best swap route for maximum output."
        />
        <StepRow
          icon={<BoltIcon />}
          title="Sweep"
          description="Approvals and swaps are batched into one transaction with EIP-7702, then your chosen token lands in your wallet."
        />
      </div>
    </div>
  );
}

function GuideStepTwo() {
  return (
    <div>
      <h2 className="text-[17px] font-bold text-slate-950 sm:text-xl">
        Best wallets for sweeping
      </h2>
      <p className="mt-1.5 text-[12px] leading-snug text-slate-500 sm:mt-2 sm:text-sm sm:leading-relaxed">
        These wallets support one-click batched sweeps. Connect one of them for the smoothest
        experience.
      </p>
      <div className="mt-3.5 grid grid-cols-3 gap-2 sm:mt-5 sm:gap-2.5">
        {SUPPORTED_WALLETS.map((wallet) => (
          <div
            key={wallet.name}
            className="flex flex-col items-center gap-1.5 rounded-[8px] border border-slate-100 bg-slate-50 px-1.5 py-2.5 sm:gap-2 sm:px-2 sm:py-3"
          >
            <Image
              src={wallet.logo}
              alt={`${wallet.name} logo`}
              width={36}
              height={36}
              className="h-8 w-8 rounded-[8px] object-contain sm:h-9 sm:w-9"
            />
            <span className="text-center text-[10px] font-semibold leading-tight text-slate-700 sm:text-[11px]">
              {wallet.name}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400 sm:mt-3 sm:text-xs">
        Other wallets work too &mdash; they simply use the Sign &amp; Sweep flow with a couple of
        extra confirmations.
      </p>
    </div>
  );
}

function GuideStepThree() {
  return (
    <div>
      <h2 className="text-[17px] font-bold text-slate-950 sm:text-xl">
        Approvals you can trust
      </h2>
      <p className="mt-1.5 text-[12px] leading-snug text-slate-500 sm:mt-2 sm:text-sm sm:leading-relaxed">
        DustSweep is built so nothing risky is ever left behind in your wallet.
      </p>
      <div className="mt-3.5 space-y-1.5 sm:mt-5 sm:space-y-2.5">
        <StepRow
          icon={<ShieldCheckIcon />}
          title="Never unlimited"
          description="We only request the exact amount each sweep needs — never unlimited approvals."
        />
        <StepRow
          icon={<ShieldCheckIcon />}
          title="Nothing left behind"
          description="Approvals are consumed inside the same transaction, so no token allowances linger afterwards."
        />
        <StepRow
          icon={<ShieldCheckIcon />}
          title="Self-custodial"
          description="Your tokens never sit with us — the swept output goes straight to your own address."
        />
      </div>
    </div>
  );
}

const STEPS = [GuideStepOne, GuideStepTwo, GuideStepThree];

export function SweepGuideModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [neverShow, setNeverShow] = useState(false);

  // Open on every visit unless the user opted out.
  useEffect(() => {
    try {
      if (localStorage.getItem(GUIDE_HIDDEN_KEY) !== "1") setIsOpen(true);
    } catch {
      setIsOpen(true);
    }
  }, []);

  const close = () => {
    try {
      if (neverShow) localStorage.setItem(GUIDE_HIDDEN_KEY, "1");
    } catch {
      // localStorage unavailable (private mode) — the guide will simply show again.
    }
    setIsOpen(false);
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, neverShow]);

  if (!isOpen) return null;

  const isLastStep = step === STEPS.length - 1;
  const StepContent = STEPS[step];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/25 px-3 pb-[calc(0.75rem+var(--safe-area-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-sm sm:px-4 sm:py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dustsweep-guide-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        id="dustsweep-guide-title"
        className="max-h-[calc(100dvh_-_1.5rem_-_env(safe-area-inset-top)_-_var(--safe-area-bottom))] w-full max-w-[340px] overflow-y-auto overscroll-contain rounded-[8px] bg-white px-3.5 pb-3.5 pt-4 shadow-[0_26px_90px_rgba(15,23,42,0.28)] sm:max-h-[calc(100dvh_-_3rem)] sm:max-w-[420px] sm:px-6 sm:pb-6 sm:pt-6"
      >
        {/* Progress dots + counter */}
        <div className="mb-3.5 flex items-center justify-between sm:mb-5">
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, index) => (
              <span
                key={index}
                className={
                  index === step
                    ? "h-1.5 w-6 rounded-full bg-blue-600 transition-all"
                    : "h-1.5 w-1.5 rounded-full bg-slate-200 transition-all"
                }
              />
            ))}
          </div>
          <span className="text-[11px] font-semibold text-slate-400">
            {step + 1} of {STEPS.length}
          </span>
        </div>

        <StepContent />

        {/* Footer: Skip left, Next right */}
        <div className="mt-4 flex items-center justify-between gap-3 sm:mt-6">
          <button
            type="button"
            onClick={close}
            className="rounded-[8px] px-3 py-2 text-sm font-semibold text-slate-400 transition hover:bg-slate-50 hover:text-slate-600 sm:py-2.5"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => (isLastStep ? close() : setStep(step + 1))}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-[8px] bg-blue-600 px-4 text-sm font-bold text-white shadow-[0_10px_24px_rgba(37,99,235,0.28)] transition hover:bg-blue-700 sm:min-h-[44px] sm:px-5"
          >
            {isLastStep ? "Start sweeping" : "Next"}
            {!isLastStep ? (
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
                <path
                  d="M9 5l7 7-7 7"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                />
              </svg>
            ) : null}
          </button>
        </div>

        <label className="mt-2.5 flex cursor-pointer items-center justify-center gap-2 text-[11px] font-medium text-slate-400 sm:mt-4 sm:text-xs">
          <input
            type="checkbox"
            checked={neverShow}
            onChange={(event) => setNeverShow(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 accent-blue-600"
          />
          Never show again
        </label>
      </div>
    </div>
  );
}
