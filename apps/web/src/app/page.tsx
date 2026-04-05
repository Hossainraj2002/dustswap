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

const PREVIEW_ITEMS = [
  {
    title: "Profile",
    src: "/ss1.png",
    caption: "Profile shows PP, streak status, referrals, and check-ins.",
  },
  {
    title: "Swap",
    src: "/ss2.png",
    caption: "Swap uses OpenOcean routing inside the same connected app flow.",
  },
  {
    title: "Leaderboard",
    src: "/ss3.png",
    caption: "Leaderboard tracks Particle Points, referrals, and swap volume.",
  },
] as const;

const HOW_IT_WORKS_STEPS = [
  {
    title: "1. Connect",
    body: "Use the same wallet flow that already powers DustSwap.",
  },
  {
    title: "2. Act",
    body: "Swap, check in, complete quests, and keep moving.",
  },
  {
    title: "3. Earn",
    body: "Tracked actions add PP, streak strength, and referrals.",
  },
  {
    title: "4. Build",
    body: "Early consistent usage builds your rank over time.",
  },
] as const;

const FAQ_ITEMS = [
  {
    question: "What is DustSwap?",
    answer: "A Base app uniting swaps, quests, streaks, and leaderboards.",
  },
  {
    question: "Do I need a wallet?",
    answer: "Yes, to swap and complete quests. You can browse without one.",
  },
  {
    question: "What is PP?",
    answer: "Particle Points reflect live participation and are intended to convert into $DUST after TGE.",
  },
  {
    question: "Which parts are live today?",
    answer: "Profile, quests, swap, streaks, referrals, and leaderboards.",
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
    <span className="inline-flex items-center rounded-full border border-sky-200/80 bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-700 shadow-[0_4px_12px_rgba(148,163,184,0.08)]">
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
      "bg-[#0066ff] text-white shadow-[0_12px_30px_rgba(0,102,255,0.2)] hover:-translate-y-0.5 hover:bg-[#0057dc]",
    secondary:
      "border border-slate-200 bg-white text-slate-900 shadow-[0_8px_20px_rgba(148,163,184,0.12)] hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50/70",
    header:
      "border border-slate-200/90 bg-white/88 text-slate-900 shadow-[0_8px_20px_rgba(148,163,184,0.1)] hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white",
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
          isConnected ? "bg-emerald-400" : "bg-sky-200"
        )}
        aria-hidden="true"
      />
      <span>{label}</span>
    </button>
  );
}

function ConnectWalletButton(props: Parameters<typeof HydratedConnectWalletButton>[0]) {
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => setIsMounted(true), []);

  if (!isMounted) {
    const variantClasses = {
      primary: "bg-[#0066ff] text-white shadow-[0_12px_30px_rgba(0,102,255,0.2)]",
      secondary: "border border-slate-200 bg-white text-slate-900 shadow-[0_8px_20px_rgba(148,163,184,0.12)]",
      header: "border border-slate-200/90 bg-white/88 text-slate-900 shadow-[0_8px_20px_rgba(148,163,184,0.1)]",
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
      <header className="fixed top-0 z-50 w-full border-b border-white/40 bg-white/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/" aria-label="DustSwap home">
            <Image
              src="/longlogo.png"
              alt="DustSwap"
              width={140}
              height={33}
              className="h-auto w-[110px] sm:w-[130px]"
              priority
            />
          </Link>

          <nav className="hidden items-center gap-1 rounded-full border border-white/70 bg-white/70 p-1 shadow-[0_4px_12px_rgba(148,163,184,0.08)] md:flex">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full px-4 py-1.5 text-sm font-medium text-slate-600 transition-colors duration-200 hover:bg-sky-50 hover:text-slate-950"
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
            onClick={() => setMobileMenuOpen((c) => !c)}
            className="flex h-10 w-10 flex-col items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white text-slate-700 md:hidden"
          >
            <span className={cx("h-[2px] w-4 bg-current transition-transform", mobileMenuOpen && "translate-y-2 rotate-45")} />
            <span className={cx("h-[2px] w-4 bg-current transition-opacity", mobileMenuOpen && "opacity-0")} />
            <span className={cx("h-[2px] w-4 bg-current transition-transform", mobileMenuOpen && "-translate-y-2 -rotate-45")} />
          </button>
        </div>
      </header>

      <div
        className={cx(
          "fixed inset-0 z-40 bg-slate-950/20 backdrop-blur-sm transition-opacity duration-200 md:hidden",
          mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
      />

      <div
        className={cx(
          "fixed inset-x-4 top-[72px] z-50 rounded-[24px] border border-white/70 bg-white/95 p-4 shadow-[0_20px_40px_rgba(15,23,42,0.12)] backdrop-blur-xl transition-all duration-200 md:hidden",
          mobileMenuOpen
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-4 opacity-0"
        )}
      >
        <div className="space-y-1.5">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-between rounded-2xl px-4 py-3 text-sm font-medium text-slate-700 hover:bg-sky-50"
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
            onAction={onWalletAction}
          />
        </div>
      </div>
    </>
  );
}

function ProductRail() {
  return (
    <div className="w-full">
      <div className="flex w-full snap-x snap-mandatory gap-4 overflow-x-auto pb-6 pt-2 no-scrollbar px-4 sm:px-6">
        {PREVIEW_ITEMS.map((item) => (
          <div
            key={item.title}
            className="w-[85vw] max-w-[340px] shrink-0 snap-center sm:max-w-[400px]"
          >
            <div className="group relative overflow-hidden rounded-[24px] border border-white/80 bg-white shadow-[0_12px_30px_rgba(148,163,184,0.1)] transition-all hover:shadow-[0_16px_40px_rgba(148,163,184,0.15)]">
              <div className="aspect-[4/5] w-full overflow-hidden sm:aspect-[4/4]">
                <img
                  src={item.src}
                  alt={item.title}
                  loading="lazy"
                  className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-105"
                />
              </div>
              <div className="absolute bottom-0 w-full bg-gradient-to-t from-white via-white/90 to-transparent p-5 pt-12">
                <p className="text-base font-semibold text-slate-900">{item.title}</p>
                <p className="mt-1 text-sm text-slate-600 line-clamp-2">{item.caption}</p>
              </div>
            </div>
          </div>
        ))}
        {/* Spacer for proper final snap */}
        <div className="w-2 shrink-0 sm:w-6" />
      </div>
    </div>
  );
}

function CompactHowItWorks() {
  const [activeStep, setActiveStep] = useState(0);

  return (
    <div className="mx-auto w-full max-w-4xl rounded-[24px] border border-white/80 bg-white/70 p-1.5 shadow-[0_12px_32px_rgba(148,163,184,0.08)] backdrop-blur-md">
      <div className="flex flex-col sm:flex-row">
        {HOW_IT_WORKS_STEPS.map((step, index) => {
          const isActive = activeStep === index;
          return (
            <button
              key={step.title}
              onClick={() => setActiveStep(index)}
              className={cx(
                "flex flex-1 flex-col items-start justify-center rounded-[20px] px-4 py-3 text-left transition-all duration-200",
                isActive ? "bg-white shadow-[0_4px_16px_rgba(148,163,184,0.1)]" : "hover:bg-white/50"
              )}
            >
              <span
                className={cx(
                  "text-xs font-semibold uppercase tracking-wider",
                  isActive ? "text-sky-600" : "text-slate-400"
                )}
              >
                {step.title}
              </span>
              {isActive && (
                <p className="mt-1 text-xs text-slate-600 animate-fade-in line-clamp-2">
                  {step.body}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CompactFAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2">
      {FAQ_ITEMS.map((item, index) => {
        const isOpen = openIndex === index;
        return (
          <div
            key={index}
            className="overflow-hidden rounded-2xl border border-white/80 bg-white/70 shadow-[0_4px_16px_rgba(148,163,184,0.06)] backdrop-blur-md transition-all"
          >
            <button
              onClick={() => setOpenIndex(isOpen ? null : index)}
              className="flex w-full items-center justify-between px-5 py-4 text-left"
            >
              <span className="text-sm font-semibold text-slate-900">{item.question}</span>
              <span className={cx("text-slate-400 transition-transform", isOpen && "rotate-180")}>
                <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            </button>
            {isOpen && (
              <div className="px-5 pb-4 pt-1 animate-fade-in">
                <p className="text-sm text-slate-600 leading-relaxed">{item.answer}</p>
              </div>
            )}
          </div>
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
        const session = await verifySiweSession({ address: connectedAddress, message, signature });
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
    async ({ address: currentAddress, isConnected: walletConnected, open }: { address?: Address; isConnected: boolean; open: (() => Promise<unknown>) | undefined; }) => {
      if (landingAuthState === "signing" || landingAuthState === "verifying") return;
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
    landingAuthState === "preparing" ? "Preparing..."
    : landingAuthState === "waitingForWallet" ? "Finish connect..."
    : landingAuthState === "signing" ? "Sign to continue"
    : landingAuthState === "verifying" ? "Verifying..."
    : isConnected && address && hasSiweSession ? "Open app"
    : isConnected ? "Sign in"
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
    <div className="relative min-h-screen overflow-hidden bg-slate-50 font-sans selection:bg-sky-200">
      {/* Background Effects */}
      <div className="pointer-events-none fixed inset-0 z-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(186,230,253,0.3),rgba(255,255,255,0))]"/>
      <div className="pointer-events-none fixed inset-0 z-0 bg-[url('/noise.png')] opacity-[0.015] mix-blend-multiply"/>
      
      <LandingHeader
        walletButtonDisabled={walletButtonDisabled}
        walletButtonLabel={walletButtonLabel}
        onWalletAction={handleLandingWalletAction}
      />

      <main className="relative z-10 pt-[104px]">
        {/* === HERO === */}
        <section className="px-4 pb-12 pt-6 sm:px-6 lg:pb-16 text-center lg:text-left">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-8 lg:flex-row lg:items-center">
            <div className="flex max-w-2xl flex-col items-center lg:items-start">
              <SectionKicker>Built on Base</SectionKicker>
              
              <h1
                className="mt-6 text-[2.5rem] font-bold leading-[1.05] tracking-tight text-slate-900 sm:text-5xl lg:text-[4rem]"
                style={{ fontFamily: "Syne, sans-serif" }}
              >
                Swap, complete quests, and build your rank on Base
              </h1>

              <p className="mt-5 max-w-lg text-lg text-slate-600 sm:text-xl">
                Earn reward on what you are already doing on base everyday.
              </p>

              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start w-full sm:w-auto">
                <ConnectWalletButton
                  variant="primary"
                  className="w-full sm:w-auto min-w-[200px]"
                  disabled={walletButtonDisabled}
                  labelOverride={walletButtonLabel}
                  onAction={handleLandingWalletAction}
                />
                <Link
                  href="/leaderboard"
                  className="inline-flex w-full sm:w-auto min-w-[160px] items-center justify-center rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-[0_8px_20px_rgba(148,163,184,0.1)] transition-all hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50"
                >
                  Leaderboard
                </Link>
              </div>

              {landingAuthError && (
                <p className="mt-3 text-sm font-medium text-rose-600">{landingAuthError}</p>
              )}

              <p className="mt-8 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                Swap features Powered by OpenOcean
              </p>
            </div>
            
            {/* Horizontal Product Showcase blending into Hero on Desktop, stacked underneath tightly on mobile */}
            <div className="w-full lg:-mr-32 lg:w-[60vw]">
              <ProductRail />
            </div>
          </div>
        </section>

        {/* === COMPACT HOW IT WORKS === */}
        <section className="px-4 py-8 sm:px-6">
          <CompactHowItWorks />
        </section>

        {/* === EARLY USERS (COFOUNDER PASS) === */}
        <section className="px-4 py-16 sm:px-6 lg:py-24">
          <div className="mx-auto max-w-6xl rounded-[32px] border border-white/80 bg-[linear-gradient(135deg,rgba(255,255,255,0.9),rgba(239,246,255,0.6))] p-2 shadow-[0_24px_60px_rgba(148,163,184,0.12)]">
            <div className="grid gap-6 overflow-hidden rounded-[26px] bg-white lg:grid-cols-2">
              <div className="flex flex-col justify-center p-8 sm:p-12">
                <div className="self-start">
                  <SectionKicker>Cofounder Pass</SectionKicker>
                </div>
                <h2
                  className="mt-6 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl"
                  style={{ fontFamily: "Syne, sans-serif" }}
                >
                  Built for early users who actually show up
                </h2>
                <p className="mt-5 text-base leading-relaxed text-slate-600">
                  DustSwap already has a live Cofounder Pass quest path inside Quests. 
                  It is built for people putting in real usage and stays secondary to the main product flow.
                  <br className="hidden sm:block" /><br className="hidden sm:block" />
                  Users who complete the Cofounder Pass quests become eligible to mint the NFT. 
                  Holding it unlocks multiple utility benefits inside the ecosystem.
                </p>
                <div className="mt-8">
                  <Link
                    href="/quests"
                    className="inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800"
                  >
                    View Quests
                  </Link>
                </div>
              </div>
              <div className="bg-slate-100/50 p-4 sm:p-6 lg:p-8">
                <div className="aspect-[1.91/1] w-full overflow-hidden rounded-[20px] border border-black/5 shadow-inner">
                  <img src="/osss.jpg" alt="Cofounder Pass" className="h-full w-full object-cover" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* === FOUNDER / TEAM === */}
        <section className="px-4 py-12 sm:px-6">
          <div className="mx-auto max-w-4xl text-center">
            <SectionKicker>Team</SectionKicker>
            <h2
              className="mt-4 text-3xl font-bold tracking-tight text-slate-900"
              style={{ fontFamily: "Syne, sans-serif" }}
            >
              Who is building this
            </h2>
          </div>
          
          <div className="mx-auto mt-10 grid max-w-4xl gap-6 sm:grid-cols-2">
            <div className="rounded-[28px] border border-white/80 bg-white shadow-[0_12px_32px_rgba(148,163,184,0.08)]">
              <div className="aspect-square overflow-hidden rounded-t-[28px]">
                <img src="/fweb3.jpg" alt="Akbar web3" className="h-full w-full object-cover grayscale transition hover:grayscale-0" />
              </div>
              <div className="p-6">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-600">Web3 / Founder</p>
                <p className="mt-2 text-xl font-bold text-slate-900">@akbarX402</p>
                <a href="https://x.com/akbarX402" className="mt-3 inline-block text-sm font-medium text-slate-500 hover:text-sky-600">Contact on X →</a>
              </div>
            </div>
            <div className="rounded-[28px] border border-white/80 bg-white shadow-[0_12px_32px_rgba(148,163,184,0.08)]">
              <div className="aspect-square overflow-hidden rounded-t-[28px]">
                <img src="/fweb2.png" alt="Akbar Hossen web2" className="h-full w-full object-cover grayscale transition hover:grayscale-0" />
              </div>
              <div className="p-6">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Web2 / Operator</p>
                <p className="mt-2 text-xl font-bold text-slate-900">Akbar Hossen</p>
                <p className="mt-2 text-sm text-slate-500">Public builder identity.</p>
              </div>
            </div>
          </div>
        </section>

        {/* === COMPACT FAQ === */}
        <section className="px-4 py-16 sm:px-6">
          <div className="mb-8 text-center">
            <SectionKicker>FAQ</SectionKicker>
            <h2 className="mt-4 text-2xl font-bold text-slate-900" style={{ fontFamily: "Syne, sans-serif" }}>
              Clarity before hype
            </h2>
          </div>
          <CompactFAQ />
        </section>

      </main>

      {/* === FOOTER === */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4 lg:grid-cols-5">
            <div className="col-span-2 lg:col-span-2">
              <Image src="/logo.png" alt="DustSwap Logo" width={32} height={32} className="h-8 w-8 rounded-full" />
              <p className="mt-4 text-sm text-slate-500 max-w-xs">
                DustSwap combines swapping, quests, streaks, referrals, and leaderboards into one clean Base application.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold tracking-wider text-slate-900">App</h3>
              <ul className="mt-4 space-y-3">
                <li><Link href="/swap" className="text-sm text-slate-600 hover:text-sky-600">Swap</Link></li>
                <li><Link href="/quests" className="text-sm text-slate-600 hover:text-sky-600">Quests</Link></li>
                <li><Link href="/leaderboard" className="text-sm text-slate-600 hover:text-sky-600">Leaderboard</Link></li>
                <li><Link href="/profile" className="text-sm text-slate-600 hover:text-sky-600">Profile</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold tracking-wider text-slate-900">Connect</h3>
              <ul className="mt-4 space-y-3">
                <li><a href="https://x.com/dustswaponbase" target="_blank" rel="noreferrer" className="text-sm text-slate-600 hover:text-sky-600">X (Twitter)</a></li>
                <li><a href="https://github.com/Hossainraj2002/dustswap" target="_blank" rel="noreferrer" className="text-sm text-slate-600 hover:text-sky-600">GitHub</a></li>
                <li><a href="https://x.com/akbarX402" target="_blank" rel="noreferrer" className="text-sm text-slate-600 hover:text-sky-600">Builder (Akbar)</a></li>
              </ul>
            </div>
          </div>
          <div className="mt-12 flex flex-col items-center justify-between border-t border-slate-100 pt-8 sm:flex-row">
            <p className="text-xs text-slate-500">
              &copy; 2026 DustSwap. All rights reserved.
            </p>
            <p className="mt-2 text-xs font-medium text-slate-400 sm:mt-0">
              Built for the Base community.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
