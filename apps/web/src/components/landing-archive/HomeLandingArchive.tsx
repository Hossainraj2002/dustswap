"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAppKit } from "@reown/appkit/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { base } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { useAccount, useSignMessage } from "wagmi";
import {
  clearStoredSiweSession,
  hasStoredSiweSession,
  requestSiweNonce,
  saveStoredSiweSession,
  verifySiweSession,
} from "@/lib/siweAuth";

const NAV_ITEMS = [
  { href: "/profile", label: "Profile" },
  { href: "/quests", label: "Quests" },
  { href: "/swap", label: "Swap" },
  { href: "/leaderboard", label: "Leaderboard" },
] as const;

const FEATURE_ITEMS = [
  {
    title: "Swap on Base",
    body: "Simple swapping through a familiar flow powered by OpenOcean.",
  },
  {
    title: "Complete Quests",
    body: "Finish live tasks and build your activity inside DustSwap.",
  },
  {
    title: "Keep Your Streak Alive",
    body: "Daily check-ins increase self-earned boost over time.",
  },
  {
    title: "Climb the Leaderboard",
    body: "Track your standing and see who is active early.",
  },
] as const;

const HOW_IT_WORKS_STEPS = [
  {
    title: "Connect your wallet",
    body: "Use the same wallet flow that powers the rest of DustSwap.",
  },
  {
    title: "Start using DustSwap",
    body: "Swap, check in, complete quests, and open the live product.",
  },
  {
    title: "Earn progress through activity",
    body: "Your actions add PP, streak boost, referrals, and visibility.",
  },
  {
    title: "Build your position early",
    body: "Consistent usage helps you move up while the app is still early.",
  },
] as const;

const FAQ_ITEMS = [
  {
    question: "What is DustSwap?",
    answer:
      "DustSwap is a Base app for swaps, quests, daily check-ins, referrals, and leaderboard progress.",
  },
  {
    question: "Do I need a wallet?",
    answer:
      "Yes for swapping, check-ins, quests, and profile activity. You can still browse the landing page without one.",
  },
  {
    question: "What is PP?",
    answer:
      "PP means Particle Points. They track your contribution inside DustSwap, and the current profile FAQ says they are intended to convert into DUST after TGE.",
  },
  {
    question: "Which parts are live today?",
    answer:
      "Profile, quests, daily check-in, referrals, swap, leaderboard, and the Cofounder Pass quest path are live today.",
  },
] as const;

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-sky-200/80 bg-white/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700 shadow-[0_6px_18px_rgba(37,99,235,0.08)]">
      {children}
    </span>
  );
}

function getErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  if (
    message.toLowerCase().includes("user rejected") ||
    message.toLowerCase().includes("rejected the request") ||
    message.toLowerCase().includes("cancelled")
  ) {
    return "Sign-in was cancelled before it finished.";
  }

  return message;
}

function HydratedConnectWalletButton({
  variant = "primary",
  className,
  connectedLabel,
  fullWidth = false,
  disabled = false,
  labelOverride,
  onAction,
}: {
  variant?: "primary" | "secondary" | "header";
  className?: string;
  connectedLabel?: string;
  fullWidth?: boolean;
  disabled?: boolean;
  labelOverride?: string;
  onAction?: (context: {
    address?: Address;
    isConnected: boolean;
    open: (() => Promise<unknown>) | undefined;
  }) => void | Promise<void>;
}) {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();

  const variantClasses = {
    primary:
      "bg-[#0066ff] text-white shadow-[0_16px_36px_rgba(0,102,255,0.22)] hover:-translate-y-0.5 hover:bg-[#0057dc]",
    secondary:
      "border border-slate-200 bg-white text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.1)] hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50/70",
    header:
      "border border-slate-200/90 bg-white/90 text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.08)] hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white",
  } as const;

  const label =
    labelOverride ??
    (isConnected && address
      ? connectedLabel ?? shortAddress(address)
      : "Connect wallet");

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        if (onAction) {
          void onAction({
            address: address as Address | undefined,
            isConnected,
            open,
          });
          return;
        }
        void open?.();
      }}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-70",
        variantClasses[variant],
        fullWidth && "w-full",
        className
      )}
      aria-label={isConnected ? "Open wallet settings" : "Connect wallet"}
    >
      <span
        className={cx(
          "h-2 w-2 rounded-full",
          isConnected ? "bg-emerald-300" : "bg-sky-200"
        )}
        aria-hidden="true"
      />
      <span>{label}</span>
    </button>
  );
}

function ConnectWalletButton(
  props: Parameters<typeof HydratedConnectWalletButton>[0]
) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => setIsMounted(true), []);

  if (!isMounted) {
    const variantClasses = {
      primary: "bg-[#0066ff] text-white shadow-[0_16px_36px_rgba(0,102,255,0.22)]",
      secondary:
        "border border-slate-200 bg-white text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.1)]",
      header:
        "border border-slate-200/90 bg-white/90 text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.08)]",
    } as const;

    return (
      <button
        type="button"
        disabled
        className={cx(
          "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold disabled:cursor-default",
          variantClasses[props.variant || "primary"],
          props.fullWidth && "w-full",
          props.className
        )}
      >
        <span className="h-2 w-2 rounded-full bg-sky-200" aria-hidden="true" />
        <span>Connect wallet</span>
      </button>
    );
  }

  return <HydratedConnectWalletButton {...props} />;
}

function LandingHeader({
  walletButtonDisabled,
  walletButtonLabel,
  onWalletAction,
}: {
  walletButtonDisabled: boolean;
  walletButtonLabel: string;
  onWalletAction: (context: {
    address?: Address;
    isConnected: boolean;
    open: (() => Promise<unknown>) | undefined;
  }) => void | Promise<void>;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  return (
    <>
      <header
        className="fixed inset-x-0 top-0 z-50 border-b border-white/70 bg-white/82 backdrop-blur-xl"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/" aria-label="DustSwap home" className="shrink-0">
            <Image
              src="/longlogo.png"
              alt="DustSwap"
              width={148}
              height={36}
              className="h-auto w-[122px] sm:w-[138px]"
              priority
            />
          </Link>

          <nav className="hidden items-center gap-1 rounded-full border border-white/80 bg-white/88 p-1 shadow-[0_10px_24px_rgba(148,163,184,0.08)] md:flex">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full px-4 py-2 text-sm font-medium text-slate-600 transition-colors duration-200 hover:bg-sky-50 hover:text-slate-950"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="hidden md:block">
            <ConnectWalletButton
              variant="header"
              connectedLabel="Connected"
              disabled={walletButtonDisabled}
              labelOverride={walletButtonLabel}
              onAction={onWalletAction}
            />
          </div>

          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((current) => !current)}
            className="flex h-11 w-11 shrink-0 flex-col items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white text-slate-700 shadow-[0_8px_22px_rgba(148,163,184,0.08)] md:hidden"
          >
            <span
              className={cx(
                "h-[2px] w-4 bg-current transition-transform duration-200",
                mobileMenuOpen && "translate-y-[7px] rotate-45"
              )}
            />
            <span
              className={cx(
                "h-[2px] w-4 bg-current transition-opacity duration-200",
                mobileMenuOpen && "opacity-0"
              )}
            />
            <span
              className={cx(
                "h-[2px] w-4 bg-current transition-transform duration-200",
                mobileMenuOpen && "-translate-y-[7px] -rotate-45"
              )}
            />
          </button>
        </div>
      </header>

      <div
        className={cx(
          "fixed inset-0 z-40 bg-slate-950/18 backdrop-blur-sm transition-opacity duration-200 md:hidden",
          mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
      />

      <div
        className={cx(
          "fixed inset-x-4 z-50 rounded-[26px] border border-white/75 bg-white/96 p-4 shadow-[0_26px_54px_rgba(15,23,42,0.14)] backdrop-blur-xl transition-all duration-200 md:hidden",
          mobileMenuOpen
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-4 opacity-0"
        )}
        style={{ top: "calc(env(safe-area-inset-top) + 72px)" }}
      >
        <div className="space-y-1.5">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-between rounded-2xl px-4 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-sky-50"
            >
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
        <div className="mt-4">
          <ConnectWalletButton
            variant="primary"
            fullWidth
            disabled={walletButtonDisabled}
            labelOverride={walletButtonLabel}
            onAction={async (context) => {
              setMobileMenuOpen(false);
              await onWalletAction(context);
            }}
          />
        </div>
      </div>
    </>
  );
}

function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[420px] lg:mx-0">
      <div className="absolute inset-x-6 top-10 h-40 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.24),rgba(59,130,246,0))] blur-3xl" />
      <div className="relative rounded-[30px] border border-white/85 bg-white/88 p-3 shadow-[0_26px_64px_rgba(37,99,235,0.14)] backdrop-blur">
        <div className="rounded-[24px] border border-sky-100/80 bg-[linear-gradient(180deg,#f8fbff_0%,#eef5ff_100%)] p-3">
          <div className="relative overflow-hidden rounded-[20px] border border-white/90 bg-white">
            <Image
              src="/ss1.png"
              alt="DustSwap profile preview"
              width={1308}
              height={1700}
              priority
              className="h-auto w-full object-cover object-top"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white via-white/90 to-transparent" />
            <div className="absolute left-3 top-3 rounded-full border border-white/90 bg-[#0066ff] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white shadow-[0_10px_24px_rgba(0,102,255,0.24)]">
              Live profile
            </div>
            <div className="absolute bottom-3 left-3 rounded-2xl border border-white/90 bg-white/95 px-3 py-2 shadow-[0_10px_24px_rgba(15,23,42,0.08)]">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Activity
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-900">
                PP, referrals, and streaks
              </p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="overflow-hidden rounded-[18px] border border-white/90 bg-white shadow-[0_10px_24px_rgba(148,163,184,0.08)]">
              <div className="aspect-[1.2/1] overflow-hidden bg-slate-50">
                <Image
                  src="/ss2.png"
                  alt="DustSwap swap preview"
                  width={1200}
                  height={920}
                  className="h-full w-full object-cover object-top"
                />
              </div>
              <div className="px-3 py-3">
                <p className="text-sm font-semibold text-slate-900">Swap</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  OpenOcean-powered routing on Base.
                </p>
              </div>
            </div>

            <div className="overflow-hidden rounded-[18px] border border-white/90 bg-white shadow-[0_10px_24px_rgba(148,163,184,0.08)]">
              <div className="aspect-[1.2/1] overflow-hidden bg-slate-50">
                <Image
                  src="/ss3.png"
                  alt="DustSwap leaderboard preview"
                  width={1200}
                  height={920}
                  className="h-full w-full object-cover object-top"
                />
              </div>
              <div className="px-3 py-3">
                <p className="text-sm font-semibold text-slate-900">Leaderboard</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Live standing for early active users.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
      {FEATURE_ITEMS.map((item, index) => (
        <article
          key={item.title}
          className="rounded-[22px] border border-white/90 bg-white/88 p-4 shadow-[0_16px_34px_rgba(148,163,184,0.08)] backdrop-blur sm:rounded-[26px] sm:p-6 sm:shadow-[0_18px_42px_rgba(148,163,184,0.08)]"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[16px] bg-[linear-gradient(135deg,#dbeafe_0%,#eff6ff_100%)] text-sm font-semibold text-sky-700 sm:h-11 sm:w-11 sm:rounded-2xl">
              0{index + 1}
            </div>
            <h3 className="text-[15px] font-semibold leading-5 text-slate-900 sm:text-base">
              {item.title}
            </h3>
          </div>
          <p className="mt-3 text-[13px] leading-5 text-slate-600 sm:mt-4 sm:text-sm sm:leading-6">
            {item.body}
          </p>
        </article>
      ))}
    </div>
  );
}

function HowItWorksGrid() {
  return (
    <div className="grid gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-4">
      {HOW_IT_WORKS_STEPS.map((step, index) => (
        <article
          key={step.title}
          className="rounded-[22px] border border-white/90 bg-white/90 p-4 shadow-[0_16px_34px_rgba(148,163,184,0.08)] sm:rounded-[26px] sm:p-6 sm:shadow-[0_18px_42px_rgba(148,163,184,0.08)]"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-600">
            Step {index + 1}
          </p>
          <h3 className="mt-2.5 text-[15px] font-semibold leading-5 text-slate-900 sm:mt-3 sm:text-lg">
            {step.title}
          </h3>
          <p className="mt-2.5 text-[13px] leading-5 text-slate-600 sm:mt-3 sm:text-sm sm:leading-6">
            {step.body}
          </p>
        </article>
      ))}
    </div>
  );
}

function FAQAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3">
      {FAQ_ITEMS.map((item, index) => {
        const isOpen = openIndex === index;

        return (
          <article
            key={item.question}
            className="overflow-hidden rounded-[24px] border border-white/90 bg-white/88 shadow-[0_16px_38px_rgba(148,163,184,0.08)]"
          >
            <button
              type="button"
              onClick={() => setOpenIndex(isOpen ? null : index)}
              className="flex w-full items-center justify-between gap-4 px-5 py-5 text-left"
            >
              <span className="text-sm font-semibold text-slate-900 sm:text-base">
                {item.question}
              </span>
              <span
                className={cx(
                  "shrink-0 text-slate-400 transition-transform duration-200",
                  isOpen && "rotate-180"
                )}
                aria-hidden="true"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </span>
            </button>
            {isOpen && (
              <div className="animate-fade-in px-5 pb-5 pt-0">
                <p className="text-sm leading-6 text-slate-600">{item.answer}</p>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

export default function Home() {
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [hasSiweSession, setHasSiweSession] = useState(false);
  const [landingAuthState, setLandingAuthState] = useState<
    "idle" | "preparing" | "waitingForWallet" | "signing" | "verifying"
  >("idle");
  const [landingAuthError, setLandingAuthError] = useState<string | null>(null);
  const [pendingNonce, setPendingNonce] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    setHasSiweSession(hasStoredSiweSession(address));
  }, [address, isConnected]);

  const completeLandingSignIn = useCallback(
    async (nonce: string, connectedAddress: Address) => {
      setPendingNonce(null);
      setLandingAuthError(null);

      try {
        setLandingAuthState("signing");
        const message = createSiweMessage({
          address: connectedAddress,
          chainId: chainId ?? base.id,
          domain: window.location.host,
          issuedAt: new Date(),
          nonce,
          statement: "Sign in to DustSwap to continue.",
          uri: window.location.origin,
          version: "1",
        });
        const signature = await signMessageAsync({ message });

        setLandingAuthState("verifying");
        const session = await verifySiweSession({
          address: connectedAddress,
          message,
          signature,
        });

        saveStoredSiweSession(session);
        setHasSiweSession(true);
        setLandingAuthState("idle");
        router.replace("/profile");
      } catch (error) {
        clearStoredSiweSession();
        setHasSiweSession(false);
        setLandingAuthState("idle");
        setLandingAuthError(getErrorMessage(error));
      }
    },
    [chainId, router, signMessageAsync]
  );

  useEffect(() => {
    if (landingAuthState === "waitingForWallet" && pendingNonce && isConnected && address) {
      void completeLandingSignIn(pendingNonce, address as Address);
    }
  }, [address, completeLandingSignIn, isConnected, landingAuthState, pendingNonce]);

  const handleLandingWalletAction = useCallback(
    async ({
      address: currentAddress,
      isConnected: walletConnected,
      open,
    }: {
      address?: Address;
      isConnected: boolean;
      open: (() => Promise<unknown>) | undefined;
    }) => {
      if (landingAuthState === "signing" || landingAuthState === "verifying") {
        return;
      }

      if (walletConnected && currentAddress && hasStoredSiweSession(currentAddress)) {
        router.replace("/profile");
        return;
      }

      if (landingAuthState === "waitingForWallet" && !walletConnected) {
        setLandingAuthError(null);
        await open?.();
        return;
      }

      setLandingAuthState("preparing");
      setLandingAuthError(null);

      try {
        const { nonce } = await requestSiweNonce();

        if (walletConnected && currentAddress) {
          await completeLandingSignIn(nonce, currentAddress);
          return;
        }

        setPendingNonce(nonce);
        setLandingAuthState("waitingForWallet");
        await open?.();
      } catch (error) {
        setPendingNonce(null);
        setLandingAuthState("idle");
        setLandingAuthError(getErrorMessage(error));
      }
    },
    [completeLandingSignIn, landingAuthState, router]
  );

  const walletButtonLabel =
    landingAuthState === "preparing"
      ? "Preparing..."
      : landingAuthState === "waitingForWallet"
        ? "Finish connecting..."
        : landingAuthState === "signing"
          ? "Sign the message..."
          : landingAuthState === "verifying"
            ? "Verifying..."
            : isConnected && address && hasSiweSession
              ? "Open profile"
              : isConnected
                ? "Sign in to continue"
                : "Connect wallet";

  const walletButtonDisabled =
    landingAuthState === "preparing" ||
    landingAuthState === "signing" ||
    landingAuthState === "verifying";

  useEffect(() => {
    if (!address) {
      setHasSiweSession(false);
      if (landingAuthState !== "idle" && landingAuthState !== "waitingForWallet") {
        setLandingAuthState("idle");
      }
    }
  }, [address, landingAuthState]);

  return (
    <div className="relative min-h-screen w-full overflow-x-clip bg-[#f4f8fc] text-slate-900 selection:bg-sky-200">
      <div className="pointer-events-none fixed inset-0 z-0 bg-[radial-gradient(circle_at_top,rgba(191,219,254,0.55),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(125,211,252,0.18),transparent_32%)]" />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-[460px] bg-[linear-gradient(180deg,rgba(255,255,255,0.65)_0%,rgba(255,255,255,0)_100%)]" />

      <LandingHeader
        walletButtonDisabled={walletButtonDisabled}
        walletButtonLabel={walletButtonLabel}
        onWalletAction={handleLandingWalletAction}
      />

      <main className="relative z-10 overflow-x-clip pt-[92px] sm:pt-[102px]">
        <section className="px-4 pb-14 pt-6 sm:px-6 sm:pb-16 lg:pb-24">
          <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center lg:gap-12">
            <div className="flex min-w-0 flex-col items-start">
              <SectionKicker>Built on Base</SectionKicker>

              <Image
                src="/longlogo.png"
                alt="DustSwap"
                width={260}
                height={62}
                priority
                className="mt-6 h-auto w-[182px] sm:w-[220px]"
              />

              <h1 className="mt-6 max-w-[11ch] font-syne text-[2.25rem] font-bold leading-[1.02] tracking-[-0.04em] text-slate-950 sm:text-[3rem] lg:text-[4.2rem]">
                Swap, complete quests, and grow on Base
              </h1>

              <p className="mt-5 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
                DustSwap turns everyday activity on Base into visible progress through
                swaps, quests, streaks, referrals, and leaderboard rank which enable
                rewards from DustSwap.
              </p>

              <div className="mt-7 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                <ConnectWalletButton
                  variant="primary"
                  fullWidth
                  className="sm:w-auto"
                  disabled={walletButtonDisabled}
                  labelOverride={walletButtonLabel}
                  onAction={handleLandingWalletAction}
                />
                <Link
                  href="/leaderboard"
                  className="inline-flex w-full items-center justify-center rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-[0_10px_24px_rgba(148,163,184,0.1)] transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50 sm:w-auto"
                >
                  Leaderboard
                </Link>
              </div>

              {landingAuthError && (
                <p className="mt-3 text-sm font-medium text-rose-600">
                  {landingAuthError}
                </p>
              )}

              <p className="mt-6 text-sm text-slate-500">
                Powered by OpenOcean for swap and bridge.
              </p>
            </div>

            <HeroVisual />
          </div>
        </section>

        <section className="px-4 py-10 sm:px-6 sm:py-16 lg:py-24">
          <div className="mx-auto max-w-6xl rounded-[28px] border border-white/85 bg-[linear-gradient(180deg,rgba(255,255,255,0.94)_0%,rgba(240,249,255,0.88)_100%)] p-4 shadow-[0_20px_46px_rgba(148,163,184,0.08)] sm:rounded-[32px] sm:p-8 sm:shadow-[0_26px_64px_rgba(148,163,184,0.1)] lg:p-10">
            <div className="max-w-2xl">
              <SectionKicker>Live Features</SectionKicker>
              <h2 className="mt-3 font-syne text-[1.7rem] font-bold tracking-[-0.03em] text-slate-950 sm:mt-4 sm:text-4xl">
                Built around activity that is already live
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-600 sm:mt-4 sm:text-base sm:leading-7">
                The app is simple on purpose. Connect, use it, and your progress shows up.
              </p>
            </div>

            <div className="mt-5 sm:mt-8">
              <FeatureGrid />
            </div>
          </div>
        </section>

        <section className="px-4 py-10 sm:px-6 sm:py-16 lg:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <SectionKicker>Flow</SectionKicker>
              <h2 className="mt-3 font-syne text-[1.7rem] font-bold tracking-[-0.03em] text-slate-950 sm:mt-4 sm:text-4xl">
                How DustSwap works
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-600 sm:mt-4 sm:text-base sm:leading-7">
                The path is straightforward. Connect once, act inside the app, and your
                account starts building a visible history.
              </p>
            </div>

            <div className="mt-5 sm:mt-8">
              <HowItWorksGrid />
            </div>
          </div>
        </section>

        <section className="px-4 py-14 sm:px-6 sm:py-16 lg:py-24">
          <div className="mx-auto max-w-6xl rounded-[32px] border border-white/90 bg-white/92 p-2 shadow-[0_26px_64px_rgba(148,163,184,0.1)]">
            <div className="grid gap-6 overflow-hidden rounded-[28px] bg-[linear-gradient(135deg,rgba(255,255,255,0.95)_0%,rgba(239,246,255,0.82)_100%)] lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]">
              <div className="flex flex-col justify-center p-6 sm:p-8 lg:p-10">
                <SectionKicker>Early users</SectionKicker>
                <h2 className="mt-5 font-syne text-3xl font-bold tracking-[-0.03em] text-slate-950 sm:text-4xl">
                  coFounder pass Built for early users who actually show up
                </h2>
                <p className="mt-5 text-base leading-7 text-slate-600">
                  Users who complete that path become eligible to mint the pass. The rest
                  of the product still stays centered on swaps, quests, streaks, referrals,
                  and leaderboard progress.
                </p>
                <div className="mt-8">
                  <Link
                    href="/quests"
                    className="inline-flex items-center rounded-full bg-slate-950 px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-slate-800"
                  >
                    Open Quests
                  </Link>
                </div>
              </div>

              <div className="p-4 sm:p-6 lg:p-8">
                <div className="overflow-hidden rounded-[24px] border border-white/90 bg-white shadow-[0_18px_44px_rgba(148,163,184,0.12)]">
                  <Image
                    src="/osss.jpg"
                    alt="DustSwap OpenSea collection preview"
                    width={1400}
                    height={960}
                    className="h-auto w-full object-cover"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="px-4 py-14 sm:px-6 sm:py-16 lg:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <SectionKicker>Team</SectionKicker>
              <h2 className="mt-4 font-syne text-3xl font-bold tracking-[-0.03em] text-slate-950 sm:text-4xl">
                Who is behind DustSwap
              </h2>
              <p className="mt-4 text-base leading-7 text-slate-600">
                DustSwap is being built by one team with a public web3 identity and a real
                world operator profile.
              </p>
            </div>

            <div className="mt-8 grid gap-5 md:grid-cols-2">
              <article className="overflow-hidden rounded-[28px] border border-white/90 bg-white shadow-[0_20px_48px_rgba(148,163,184,0.1)]">
                <div className="aspect-[1/1.02] overflow-hidden bg-slate-100">
                  <Image
                    src="/fweb3.jpg"
                    alt="Akbar web3 founder profile"
                    width={1200}
                    height={1220}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="p-6 sm:p-7">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-600">
                    Builder and founder
                  </p>
                  <h3 className="mt-3 text-2xl font-semibold text-slate-950">Akbar</h3>
                  <p className="mt-2 text-sm text-slate-500">web3</p>
                  <a
                    href="https://x.com/akbarX402"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-5 inline-flex items-center rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors duration-200 hover:border-sky-200 hover:bg-sky-50"
                  >
                    Contact builder on X
                  </a>
                </div>
              </article>

              <article className="overflow-hidden rounded-[28px] border border-white/90 bg-white shadow-[0_20px_48px_rgba(148,163,184,0.1)]">
                <div className="aspect-[1/1.02] overflow-hidden bg-slate-100">
                  <Image
                    src="/fweb2.png"
                    alt="Akbar Hossen profile"
                    width={1200}
                    height={1220}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="p-6 sm:p-7">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Web2
                  </p>
                  <h3 className="mt-3 text-2xl font-semibold text-slate-950">
                    Akbar Hossen
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    Public operator identity for the project.
                  </p>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="px-4 py-14 sm:px-6 sm:py-16 lg:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <SectionKicker>FAQ</SectionKicker>
              <h2 className="mt-4 font-syne text-3xl font-bold tracking-[-0.03em] text-slate-950 sm:text-4xl">
                Clarity before hype
              </h2>
              <p className="mt-4 text-base leading-7 text-slate-600">
                A few direct answers based on how the product works today.
              </p>
            </div>

            <div className="mt-8">
              <FAQAccordion />
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-slate-200/80 bg-white/88">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-sm">
              <Image
                src="/longlogo.png"
                alt="DustSwap"
                width={150}
                height={36}
                className="h-auto w-[132px]"
              />
              <p className="mt-4 text-sm leading-6 text-slate-500">
                DustSwap combines swaps, quests, streaks, referrals, and leaderboard
                progress into one Base app.
              </p>
            </div>

            <div className="grid gap-8 sm:grid-cols-2">
              <div>
                <p className="text-sm font-semibold text-slate-950">Project</p>
                <div className="mt-4 space-y-3">
                  <a
                    href="https://x.com/dustswaponbase"
                    target="_blank"
                    rel="noreferrer"
                    className="block text-sm text-slate-600 transition-colors hover:text-sky-600"
                  >
                    X
                  </a>
                  <a
                    href="https://github.com/Hossainraj2002/dustswap"
                    target="_blank"
                    rel="noreferrer"
                    className="block text-sm text-slate-600 transition-colors hover:text-sky-600"
                  >
                    GitHub
                  </a>
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-slate-950">App</p>
                <div className="mt-4 space-y-3">
                  {NAV_ITEMS.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="block text-sm text-slate-600 transition-colors hover:text-sky-600"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-10 border-t border-slate-100 pt-6 text-xs text-slate-400">
            Built on Base with a shared wallet flow across the full app.
          </div>
        </div>
      </footer>
    </div>
  );
}
