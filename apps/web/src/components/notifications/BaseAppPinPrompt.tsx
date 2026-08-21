"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import {
  useBaseAppPinPrompt,
  type PinBenefit,
  type PinPromptKind,
} from "@/hooks/useBaseAppPinPrompt";

/**
 * Bottom sheet asking a Base App user to save DustSwap or switch notifications
 * on. Rendered only when useBaseAppPinPrompt has confirmed the Base App
 * environment and asked Base what this specific wallet is missing.
 *
 * A sheet rather than a centre modal on purpose: Base App is mobile only, and a
 * sheet reads as an offer that can be ignored rather than an interruption that
 * has to be dealt with.
 *
 * The buttons cannot pin the app themselves. `addMiniApp` was retired in the
 * April 2026 migration and the Base App now handles saving through its own
 * chrome, so the honest design is to say what the user gets, point at where the
 * control lives, and get out of the way.
 */

const COPY: Record<
  PinPromptKind,
  { eyebrow: string; title: string; body: string; hint: string; confirm: string }
> = {
  // Body copy stays generic on purpose. It used to promise a dust alert, which
  // ships disabled, so the sheet was advertising a notification the backend
  // never sends. The specifics now come from the server-supplied benefit list
  // below, which only ever lists live campaigns.
  pin: {
    eyebrow: "Base App",
    title: "Never miss a streak",
    body: "Save DustSwap in Base App to get a reminder before your check-in streak resets, so you keep your points boost.",
    hint: "Open the Base App menu, then tap Save.",
    confirm: "I saved it",
  },
  enable: {
    eyebrow: "Base App",
    title: "Turn on notifications",
    body: "DustSwap is saved. Switch notifications on to get a reminder before your check-in streak resets, so you keep your points boost.",
    hint: "Base App settings, then Notifications, then DustSwap.",
    confirm: "Done",
  },
};

/**
 * Icon shapes only. Which benefits appear, and their wording, come from the
 * server, so the sheet can never advertise a campaign that is switched off.
 */
const BENEFIT_ICONS: Record<PinBenefit["icon"], string> = {
  // Bell. A reminder, not a clock.
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  // Sparkle. A trash can would read as "delete my tokens", which is the
  // opposite of what a sweep does with them.
  sparkle:
    "M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3ZM18.5 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z",
  // Ticket with a perforation, rather than a clock.
  ticket:
    "M3 9.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2.5 2.5 0 0 0 0 5 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2.5 2.5 0 0 0 0-5ZM14 8v1.5M14 13v3",
};

export type BaseAppPinPromptViewProps = {
  kind: PinPromptKind;
  benefits: PinBenefit[];
  visible: boolean;
  onDismiss: () => void;
  onComplete: () => void;
};

/**
 * Presentation only, so the sheet can be rendered and reviewed without a Base
 * App runtime. `BaseAppPinPrompt` below is the wired version.
 */
export function BaseAppPinPromptView({
  kind,
  benefits,
  visible,
  onDismiss,
  onComplete,
}: BaseAppPinPromptViewProps) {
  const [mounted, setMounted] = useState(false);

  // One frame between render and transform so the slide-up actually animates
  // instead of the sheet appearing already in place.
  useEffect(() => {
    if (!visible) {
      setMounted(false);
      return;
    }

    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  if (!visible) {
    return null;
  }

  const copy = COPY[kind];

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="baseapp-pin-title"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onDismiss}
        className={`absolute inset-0 bg-slate-950/40 backdrop-blur-[2px] transition-opacity duration-300 dark:bg-black/60 motion-reduce:transition-none ${
          mounted ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        className={`relative w-full max-w-[440px] transition-transform duration-300 ease-out motion-reduce:transition-none ${
          mounted ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div
          // The mobile shell nav is fixed at the bottom, so the sheet has to end
          // above it or the action buttons land underneath it. AppShell already
          // publishes its height as --ds-mobile-fixed-bottom-offset; the nav is
          // md:hidden, so the reserve is dropped again at md.
          className="overflow-hidden rounded-t-[24px] border-x border-t border-slate-200 bg-white pb-[calc(var(--ds-mobile-fixed-bottom-offset,0px)+0.75rem)] dark:border-white/10 dark:bg-[#0d1117] md:pb-[env(safe-area-inset-bottom)]"
          // Inline rather than a shadow-[...] utility: globals.css normalises
          // every arbitrary shadow to the flat card shadow in dark mode.
          style={{ boxShadow: "0 -20px 60px rgba(15,23,42,0.22)" }}
        >
          <div className="h-[3px] bg-[linear-gradient(90deg,#0ea5e9,#2563eb,#22c55e)]" />

          <div className="px-5 pb-5 pt-5">
            <div className="flex items-start gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[13px] border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.06]">
                <Image
                  src="/logo.png"
                  alt=""
                  width={44}
                  height={44}
                  className="h-full w-full object-cover"
                />
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-sky-600 dark:text-sky-400">
                  {copy.eyebrow}
                </p>
                <h2
                  id="baseapp-pin-title"
                  className="mt-1 text-[19px] font-black leading-tight tracking-[-0.01em] text-slate-900 dark:text-white"
                >
                  {copy.title}
                </h2>
              </div>

              <button
                type="button"
                onClick={onDismiss}
                aria-label="Close"
                className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-white/[0.08] dark:hover:text-slate-200"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <p className="mt-3.5 text-[14px] leading-relaxed text-slate-600 dark:text-slate-300">
              {copy.body}
            </p>

            {benefits.length > 0 && (
            <ul className="mt-4 space-y-2.5">
              {benefits.map((benefit) => (
                <li key={benefit.label} className="flex items-center gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600 dark:bg-sky-400/10 dark:text-sky-400">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d={BENEFIT_ICONS[benefit.icon]} />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-bold leading-tight text-slate-900 dark:text-white">
                      {benefit.label}
                    </span>
                    <span className="block text-[12px] leading-tight text-slate-500 dark:text-slate-400">
                      {benefit.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            )}

            <p className="mt-4 rounded-[13px] border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[12.5px] font-semibold leading-snug text-slate-600 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-300">
              {copy.hint}
            </p>

            <div className="mt-4 grid grid-cols-[1fr_auto] gap-2.5">
              <button
                type="button"
                onClick={onComplete}
                className="min-h-[46px] rounded-[14px] bg-[linear-gradient(135deg,#0ea5e9,#2563eb)] px-4 text-[14px] font-black text-white transition active:scale-[0.98]"
                style={{ boxShadow: "0 10px 24px rgba(37,99,235,0.28)" }}
              >
                {copy.confirm}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="min-h-[46px] rounded-[14px] border border-slate-200 bg-white px-4 text-[14px] font-bold text-slate-600 transition hover:bg-slate-50 active:scale-[0.98] dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-300 dark:hover:bg-white/[0.1]"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


/**
 * Wired version mounted in AppShell. Renders nothing at all until
 * useBaseAppPinPrompt has confirmed both the Base App environment and that
 * this wallet is actually missing something.
 */
export function BaseAppPinPrompt() {
  const { kind, benefits, visible, dismiss, complete } = useBaseAppPinPrompt();

  if (!kind) {
    return null;
  }

  return (
    <BaseAppPinPromptView
      kind={kind}
      benefits={benefits}
      visible={visible}
      onDismiss={dismiss}
      onComplete={complete}
    />
  );
}

export default BaseAppPinPrompt;
