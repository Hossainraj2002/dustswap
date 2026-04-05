"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAppKit } from "@reown/appkit/react";
import { useEffect, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";

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
    fallbackKind: "profile" as const,
    caption: "Profile shows PP, streak status, referrals, and daily check-in controls.",
  },
  {
    title: "Swap",
    src: "/ss2.png",
    fallbackKind: "swap" as const,
    caption: "Swap uses OpenOcean routing inside the same connected app flow.",
  },
  {
    title: "Leaderboard",
    src: "/ss3.png",
    fallbackKind: "leaderboard" as const,
    caption: "Leaderboard tracks Particle Points, referrals, and swap volume.",
  },
] as const;

const FEATURE_CARDS = [
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
    body: "Use the same wallet flow that already powers DustSwap across normal EVM wallets and smart wallets.",
  },
  {
    title: "Start using DustSwap",
    body: "Swap, check in, complete quests, and keep your profile moving from one connected account.",
  },
  {
    title: "Earn progress through activity",
    body: "Tracked actions add PP, streak strength, referrals, and leaderboard movement over time.",
  },
  {
    title: "Build your position early",
    body: "Early consistent usage matters because the product records what you actually do, not just when you arrived.",
  },
] as const;

const FAQ_ITEMS = [
  {
    question: "What is DustSwap?",
    answer:
      "DustSwap is a Base app that combines swaps, quests, streaks, referrals, and leaderboard progress in one place.",
  },
  {
    question: "Do I need a wallet?",
    answer:
      "You need a wallet to swap, complete quests, check in, and track progress. You can still browse the landing page and leaderboard before connecting.",
  },
  {
    question: "What is PP?",
    answer:
      "PP means Particle Points. DustSwap uses PP to reflect live participation from quests, check-ins, referrals, and tracked activity, and the profile FAQ states PP is intended to convert into $DUST after TGE.",
  },
  {
    question: "Which parts are live today?",
    answer:
      "Profile, quests, swap, daily streaks, referrals, and leaderboard views are live now. Dust Sweep is still under development, so it is not part of the current navigation.",
  },
] as const;

type PreviewKind = "profile" | "swap" | "leaderboard";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-sky-200/80 bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-700 shadow-[0_10px_24px_rgba(148,163,184,0.10)]">
      {children}
    </span>
  );
}

function ConnectWalletButton({
  variant = "primary",
  className,
  connectedLabel,
  fullWidth = false,
  onConnectStart,
}: {
  variant?: "primary" | "secondary" | "header";
  className?: string;
  connectedLabel?: string;
  fullWidth?: boolean;
  onConnectStart?: () => void;
}) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    const variantClasses = {
      primary:
        "bg-[#0066ff] text-white shadow-[0_18px_50px_rgba(0,102,255,0.26)]",
      secondary:
        "border border-slate-200 bg-white text-slate-900 shadow-[0_14px_36px_rgba(148,163,184,0.16)]",
      header:
        "border border-slate-200/90 bg-white/88 text-slate-900 shadow-[0_12px_32px_rgba(148,163,184,0.14)]",
    } as const;

    return (
      <button
        type="button"
        disabled
        className={cx(
          "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-all duration-200 disabled:cursor-default",
          variantClasses[variant],
          fullWidth && "w-full",
          className
        )}
        aria-label="Connect wallet"
      >
        <span className="h-2.5 w-2.5 rounded-full bg-sky-200" aria-hidden="true" />
        <span>Connect wallet</span>
      </button>
    );
  }

  return (
    <HydratedConnectWalletButton
      variant={variant}
      className={className}
      connectedLabel={connectedLabel}
      fullWidth={fullWidth}
      onConnectStart={onConnectStart}
    />
  );
}

function HydratedConnectWalletButton({
  variant = "primary",
  className,
  connectedLabel,
  fullWidth = false,
  onConnectStart,
}: {
  variant?: "primary" | "secondary" | "header";
  className?: string;
  connectedLabel?: string;
  fullWidth?: boolean;
  onConnectStart?: () => void;
}) {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();

  const variantClasses = {
    primary:
      "bg-[#0066ff] text-white shadow-[0_18px_50px_rgba(0,102,255,0.26)] hover:-translate-y-0.5 hover:bg-[#0057dc]",
    secondary:
      "border border-slate-200 bg-white text-slate-900 shadow-[0_14px_36px_rgba(148,163,184,0.16)] hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50/70",
    header:
      "border border-slate-200/90 bg-white/88 text-slate-900 shadow-[0_12px_32px_rgba(148,163,184,0.14)] hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white",
  } as const;

  const label =
    isConnected && address
      ? connectedLabel ?? shortAddress(address)
      : "Connect wallet";

  return (
    <button
      type="button"
      onClick={() => {
        if (!isConnected) {
          onConnectStart?.();
        }
        void open?.();
      }}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-all duration-200",
        variantClasses[variant],
        fullWidth && "w-full",
        className
      )}
      aria-label={isConnected ? "Open wallet connection settings" : "Connect wallet"}
    >
      <span
        className={cx(
          "h-2.5 w-2.5 rounded-full",
          isConnected ? "bg-emerald-400" : "bg-sky-200"
        )}
        aria-hidden="true"
      />
      <span>{label}</span>
    </button>
  );
}

function PreviewFallback({ kind }: { kind: PreviewKind }) {
  if (kind === "profile") {
    return (
      <div className="flex h-full flex-col justify-between rounded-[28px] bg-[linear-gradient(180deg,#ffffff_0%,#eef6ff_100%)] p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffffff_0%,#dbeafe_52%,#93c5fd_100%)] text-sm font-semibold text-slate-700">
              DS
            </div>
            <div>
              <div className="h-3.5 w-24 rounded-full bg-slate-900/90" />
              <div className="mt-2 h-3 w-16 rounded-full bg-slate-300" />
            </div>
          </div>
          <div className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-semibold text-sky-700">
            Active
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3">
          {[
            { label: "PP", value: "12,450" },
            { label: "Boost", value: "180%" },
            { label: "Rank", value: "#24" },
            { label: "Referrals", value: "18" },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-[20px] border border-white/90 bg-white/85 p-3 shadow-[0_12px_28px_rgba(148,163,184,0.10)]"
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                {item.label}
              </p>
              <p className="mt-2 text-lg font-semibold tracking-[-0.05em] text-slate-950">
                {item.value}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-5 rounded-[22px] border border-white/90 bg-white/88 p-4 shadow-[0_14px_30px_rgba(148,163,184,0.10)]">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
              Streak
            </p>
            <p className="text-xs font-medium text-slate-500">Day 12</p>
          </div>
          <div className="mt-3 grid grid-cols-6 gap-2">
            {Array.from({ length: 12 }).map((_, index) => (
              <span
                key={index}
                className={cx(
                  "h-2 rounded-full",
                  index < 9 ? "bg-sky-400" : "bg-slate-200"
                )}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (kind === "swap") {
    return (
      <div className="flex h-full flex-col rounded-[28px] bg-[linear-gradient(180deg,#ffffff_0%,#eff6ff_100%)] p-5">
        <div className="rounded-[24px] border border-white/90 bg-white/88 p-4 shadow-[0_14px_32px_rgba(148,163,184,0.10)]">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
              From
            </p>
            <p className="text-xs font-medium text-slate-500">Base</p>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-10 w-10 rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffffff_0%,#cbd5e1_48%,#94a3b8_100%)]" />
              <div>
                <p className="text-sm font-semibold text-slate-950">ETH</p>
                <p className="text-xs text-slate-500">0.48</p>
              </div>
            </div>
            <div className="h-3 w-20 rounded-full bg-slate-200" />
          </div>
        </div>

        <div className="mx-auto my-4 flex h-11 w-11 items-center justify-center rounded-full border border-sky-200 bg-white text-sky-600 shadow-[0_12px_28px_rgba(96,165,250,0.18)]">
          <span className="text-lg">+</span>
        </div>

        <div className="rounded-[24px] border border-white/90 bg-white/88 p-4 shadow-[0_14px_32px_rgba(148,163,184,0.10)]">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
              To
            </p>
            <p className="text-xs font-medium text-slate-500">Estimated route</p>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-[20px] border border-sky-100 bg-sky-50/70 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-10 w-10 rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffffff_0%,#fde68a_48%,#f59e0b_100%)]" />
              <div>
                <p className="text-sm font-semibold text-slate-950">USDC</p>
                <p className="text-xs text-slate-500">~1,235.44</p>
              </div>
            </div>
            <div className="rounded-full bg-slate-950 px-3 py-1 text-[11px] font-semibold text-white">
              OpenOcean
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-[22px] border border-white/90 bg-white/88 p-4 shadow-[0_14px_30px_rgba(148,163,184,0.10)]">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-950">Route summary</p>
            <p className="text-xs text-slate-500">Live widget flow</p>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-sm text-slate-600">Wallet connection stays shared with the app.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-[28px] bg-[linear-gradient(180deg,#ffffff_0%,#eef6ff_100%)] p-5">
      <div className="flex items-center justify-between rounded-[22px] border border-white/90 bg-white/88 px-4 py-3 shadow-[0_14px_32px_rgba(148,163,184,0.10)]">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
            Board
          </p>
          <p className="mt-1 text-base font-semibold text-slate-950">Particle Points</p>
        </div>
        <div className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-semibold text-sky-700">
          Live
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {[
          { rank: "01", name: "@earlybuilder", score: "48,200 PP" },
          { rank: "02", name: "@dustpilot", score: "41,880 PP" },
          { rank: "03", name: "@baseuser", score: "39,105 PP" },
          { rank: "24", name: "You", score: "12,450 PP" },
        ].map((row, index) => (
          <div
            key={row.rank}
            className={cx(
              "grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 rounded-[20px] border px-4 py-3 shadow-[0_12px_30px_rgba(148,163,184,0.08)]",
              index === 3
                ? "border-sky-200 bg-sky-50/80"
                : "border-white/90 bg-white/88"
            )}
          >
            <span className="text-sm font-semibold text-slate-500">#{row.rank}</span>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#ffffff_0%,#dbeafe_46%,#93c5fd_100%)] text-xs font-semibold text-slate-700">
                {row.rank === "24" ? "DS" : row.rank}
              </span>
              <span className="truncate text-sm font-medium text-slate-900">{row.name}</span>
            </div>
            <span className="text-xs font-semibold text-slate-500">{row.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MediaSurface({
  src,
  alt,
  fallback,
  fallbackSrc,
  className,
  imageClassName,
}: {
  src?: string;
  alt: string;
  fallback: ReactNode;
  fallbackSrc?: string;
  className?: string;
  imageClassName?: string;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const sources = [src, fallbackSrc].filter(Boolean) as string[];

  useEffect(() => {
    setSourceIndex(0);
  }, [src, fallbackSrc]);

  const activeSource = sources[sourceIndex];

  return (
    <div
      className={cx(
        "overflow-hidden rounded-[28px] border border-white/80 bg-white/80 shadow-[0_24px_60px_rgba(148,163,184,0.16)]",
        className
      )}
    >
      {activeSource ? (
        <img
          src={activeSource}
          alt={alt}
          className={cx("h-full w-full object-cover", imageClassName)}
          loading="lazy"
          onError={() => {
            if (sourceIndex < sources.length) {
              setSourceIndex((current) => current + 1);
            }
          }}
        />
      ) : (
        fallback
      )}
    </div>
  );
}

function FounderFallback({
  label,
  tone,
}: {
  label: string;
  tone: "web3" | "web2";
}) {
  return (
    <div
      className={cx(
        "flex h-full min-h-[320px] items-end rounded-[28px] p-6",
        tone === "web3"
          ? "bg-[radial-gradient(circle_at_top_left,#dbeafe_0%,#93c5fd_36%,#0f172a_100%)]"
          : "bg-[radial-gradient(circle_at_top_left,#f8fafc_0%,#cbd5e1_42%,#1e293b_100%)]"
      )}
    >
      <div className="rounded-[24px] border border-white/25 bg-white/10 px-5 py-4 text-white backdrop-blur">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">
          {tone}
        </p>
        <p className="mt-3 text-4xl font-semibold tracking-[-0.08em]">{label}</p>
      </div>
    </div>
  );
}

function LandingHeader() {
  const { isConnected } = useAccount();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [redirectToProfileAfterConnect, setRedirectToProfileAfterConnect] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (redirectToProfileAfterConnect && isConnected) {
      setRedirectToProfileAfterConnect(false);
      router.replace("/profile");
    }
  }, [isConnected, redirectToProfileAfterConnect, router]);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-white/60 bg-white/72 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="inline-flex items-center rounded-full border border-white/70 bg-white/88 px-4 py-2 shadow-[0_14px_32px_rgba(148,163,184,0.14)]"
            aria-label="DustSwap home"
          >
            <Image
              src="/longlogo.png"
              alt="DustSwap"
              width={176}
              height={42}
              className="h-auto w-[132px] sm:w-[148px]"
              priority
            />
          </Link>

          <nav className="hidden items-center gap-1 rounded-full border border-white/70 bg-white/70 p-1 shadow-[0_14px_32px_rgba(148,163,184,0.12)] md:flex">
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

          <div className="hidden items-center md:flex">
            <ConnectWalletButton
              variant="header"
              connectedLabel="Wallet connected"
              onConnectStart={() => setRedirectToProfileAfterConnect(true)}
            />
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((current) => !current)}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-[0_10px_24px_rgba(148,163,184,0.12)] md:hidden"
            aria-expanded={mobileMenuOpen}
            aria-controls="landing-mobile-menu"
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          >
            <div className="flex w-5 flex-col gap-1.5">
              <span
                className={cx(
                  "h-0.5 w-5 rounded-full bg-current transition-transform duration-200",
                  mobileMenuOpen && "translate-y-2 rotate-45"
                )}
              />
              <span
                className={cx(
                  "h-0.5 w-5 rounded-full bg-current transition-opacity duration-200",
                  mobileMenuOpen && "opacity-0"
                )}
              />
              <span
                className={cx(
                  "h-0.5 w-5 rounded-full bg-current transition-transform duration-200",
                  mobileMenuOpen && "-translate-y-2 -rotate-45"
                )}
              />
            </div>
          </button>
        </div>
      </header>

      <div
        className={cx(
          "fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-sm transition-opacity duration-200 md:hidden",
          mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
      />

      <div
        id="landing-mobile-menu"
        className={cx(
          "fixed inset-x-4 top-[84px] z-50 rounded-[30px] border border-white/70 bg-white/92 p-4 shadow-[0_30px_80px_rgba(15,23,42,0.16)] backdrop-blur-xl transition-all duration-200 md:hidden",
          mobileMenuOpen
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-4 opacity-0"
        )}
      >
        <div className="space-y-2">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-between rounded-[22px] border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm font-medium text-slate-700 transition-colors duration-200 hover:border-sky-200 hover:bg-sky-50"
            >
              <span>{item.label}</span>
              <span className="text-sky-600">Open</span>
            </Link>
          ))}
        </div>

        <div className="mt-4">
          <ConnectWalletButton
            variant="primary"
            connectedLabel="Wallet connected"
            fullWidth
            onConnectStart={() => setRedirectToProfileAfterConnect(true)}
          />
        </div>
      </div>
    </>
  );
}

export default function Home() {
  const { isConnected } = useAccount();
  const [redirectToProfileAfterConnect, setRedirectToProfileAfterConnect] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (redirectToProfileAfterConnect && isConnected) {
      setRedirectToProfileAfterConnect(false);
      router.replace("/profile");
    }
  }, [isConnected, redirectToProfileAfterConnect, router]);

  return (
    <div className="relative overflow-hidden bg-transparent">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.22),transparent_34%),radial-gradient(circle_at_20%_20%,rgba(125,211,252,0.24),transparent_24%),radial-gradient(circle_at_80%_18%,rgba(191,219,254,0.68),transparent_24%),linear-gradient(180deg,#f8fbff_0%,#eef4fb_42%,#f6f9fd_100%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:96px_96px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.7),transparent_85%)]"
      />

      <LandingHeader />

      <div className="relative z-10">
        <section className="px-4 pb-20 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pb-28 lg:pt-20">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              <SectionKicker>Built on Base</SectionKicker>

              <div className="mt-6">
                <Image
                  src="/longlogo.png"
                  alt="DustSwap"
                  width={420}
                  height={110}
                  className="h-auto w-[220px] sm:w-[270px] lg:w-[320px]"
                  priority
                />
              </div>

              <h1
                className="mt-8 max-w-3xl text-4xl font-semibold tracking-[-0.08em] text-slate-950 sm:text-5xl lg:text-[4.5rem] lg:leading-[0.96]"
                style={{ fontFamily: "Syne, sans-serif" }}
              >
                Swap, complete quests, and grow on Base
              </h1>

              <p className="mt-6 max-w-2xl text-base leading-8 text-slate-600 sm:text-lg">
                DustSwap turns everyday activity on Base into visible progress
                through swaps, quests, streaks, referrals, and leaderboard rank
                that shape rewards inside DustSwap.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <ConnectWalletButton
                  variant="primary"
                  connectedLabel="Wallet connected"
                  onConnectStart={() => setRedirectToProfileAfterConnect(true)}
                />
                <Link
                  href="/leaderboard"
                  className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-[0_14px_36px_rgba(148,163,184,0.16)] transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50/70"
                >
                  Leaderboard
                </Link>
              </div>

              <p className="mt-5 text-sm font-medium text-slate-500">
                Powered by OpenOcean for swap &amp; bridge
              </p>
            </div>

            <div className="relative">
              <div className="absolute -left-10 top-8 h-36 w-36 rounded-full bg-sky-300/25 blur-3xl" />
              <div className="absolute -right-8 bottom-2 h-48 w-48 rounded-full bg-blue-500/18 blur-3xl" />

              <div className="relative overflow-hidden rounded-[34px] border border-white/80 bg-white/78 p-5 shadow-[0_30px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-700">
                      Live Product View
                    </p>
                    <h2
                      className="mt-3 text-2xl font-semibold tracking-[-0.06em] text-slate-950"
                      style={{ fontFamily: "Syne, sans-serif" }}
                    >
                      Built for people who actually use the app
                    </h2>
                  </div>
                  <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-700">
                    Wallet ready
                  </div>
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  {[
                    {
                      title: "Swap flow",
                      body: "OpenOcean routing inside the same app connection.",
                    },
                    {
                      title: "Quest progress",
                      body: "Live tasks and referral paths already tracked on profile.",
                    },
                    {
                      title: "Daily streak",
                      body: "Check-ins build self-earned boost over time.",
                    },
                    {
                      title: "Leaderboard rank",
                      body: "Track PP, referrals, and active early wallets.",
                    },
                  ].map((item) => (
                    <article
                      key={item.title}
                      className="rounded-[24px] border border-white/90 bg-[linear-gradient(180deg,rgba(255,255,255,0.95),rgba(239,246,255,0.88))] p-4 shadow-[0_16px_32px_rgba(148,163,184,0.10)]"
                    >
                      <p className="text-sm font-semibold text-slate-950">{item.title}</p>
                      <p className="mt-2 text-sm leading-6 text-slate-600">{item.body}</p>
                    </article>
                  ))}
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  {["Base", "Smart wallet", "EVM", "Referral path"].map((chip) => (
                    <span
                      key={chip}
                      className="rounded-full border border-sky-100 bg-sky-50/70 px-3 py-1 text-xs font-medium text-sky-700"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="px-4 py-20 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <SectionKicker>Product Preview</SectionKicker>
            <div className="mt-6 max-w-3xl">
              <h2
                className="text-3xl font-semibold tracking-[-0.07em] text-slate-950 sm:text-4xl"
                style={{ fontFamily: "Syne, sans-serif" }}
              >
                See how DustSwap works
              </h2>
              <p className="mt-4 text-base leading-8 text-slate-600">
                A clean view of the product users actually interact with.
              </p>
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-3">
              {PREVIEW_ITEMS.map((item) => (
                <article key={item.title} className="space-y-4">
                  <MediaSurface
                    src={item.src}
                    alt={`${item.title} preview`}
                    className="min-h-[340px]"
                    imageClassName="h-[340px] object-cover object-top"
                    fallback={<PreviewFallback kind={item.fallbackKind} />}
                  />
                  <div className="rounded-[24px] border border-white/80 bg-white/72 p-4 shadow-[0_18px_40px_rgba(148,163,184,0.12)]">
                    <p className="text-base font-semibold text-slate-950">{item.title}</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{item.caption}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 py-20 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <SectionKicker>Live Features</SectionKicker>
            <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <h2
                  className="text-3xl font-semibold tracking-[-0.07em] text-slate-950 sm:text-4xl"
                  style={{ fontFamily: "Syne, sans-serif" }}
                >
                  DustSwap stays close to the product that is live now
                </h2>
              </div>
              <p className="max-w-xl text-sm leading-7 text-slate-500 sm:text-base">
                No filler features. These are the actions people can already use today.
              </p>
            </div>

            <div className="mt-10 grid gap-5 md:grid-cols-2">
              {FEATURE_CARDS.map((card, index) => (
                <article
                  key={card.title}
                  className="group overflow-hidden rounded-[28px] border border-white/80 bg-white/78 p-6 shadow-[0_22px_54px_rgba(148,163,184,0.14)] transition-transform duration-200 hover:-translate-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,#0f172a,#0066ff)] text-sm font-semibold text-white shadow-[0_16px_32px_rgba(0,102,255,0.24)]">
                      0{index + 1}
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-700">
                      Live
                    </span>
                  </div>
                  <h3 className="mt-6 text-xl font-semibold tracking-[-0.04em] text-slate-950">
                    {card.title}
                  </h3>
                  <p className="mt-3 max-w-md text-sm leading-7 text-slate-600 sm:text-base">
                    {card.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 py-20 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl overflow-hidden rounded-[34px] border border-white/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.84),rgba(239,246,255,0.78))] p-6 shadow-[0_28px_72px_rgba(148,163,184,0.16)] backdrop-blur-xl sm:p-8 lg:p-10">
            <div className="max-w-3xl">
              <SectionKicker>How It Works</SectionKicker>
              <h2
                className="mt-6 text-3xl font-semibold tracking-[-0.07em] text-slate-950 sm:text-4xl"
                style={{ fontFamily: "Syne, sans-serif" }}
              >
                How DustSwap works
              </h2>
            </div>

            <div className="mt-10 grid gap-4 lg:grid-cols-4">
              {HOW_IT_WORKS_STEPS.map((step, index) => (
                <article
                  key={step.title}
                  className="rounded-[28px] border border-white/90 bg-white/80 p-5 shadow-[0_18px_44px_rgba(148,163,184,0.12)]"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full border border-sky-200 bg-sky-50 text-sm font-semibold text-sky-700">
                      {index + 1}
                    </span>
                    <p className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-400">
                      Step {index + 1}
                    </p>
                  </div>
                  <h3 className="mt-6 text-lg font-semibold tracking-[-0.03em] text-slate-950">
                    {step.title}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-slate-600">{step.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 py-20 sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
            <div className="rounded-[34px] border border-white/80 bg-white/76 p-6 shadow-[0_28px_72px_rgba(148,163,184,0.16)] backdrop-blur-xl sm:p-8">
              <SectionKicker>Early Users</SectionKicker>
              <h2
                className="mt-6 text-3xl font-semibold tracking-[-0.07em] text-slate-950 sm:text-4xl"
                style={{ fontFamily: "Syne, sans-serif" }}
              >
                Built for early users who actually show up
              </h2>
              <p className="mt-5 text-base leading-8 text-slate-600">
                DustSwap already has a live cofounder pass quest path for early users
                inside Quests. It is there for people putting in real usage, and it
                stays secondary to the main product flow.
              </p>

              <div className="mt-8">
                <Link
                  href="/quests"
                  className="inline-flex items-center justify-center rounded-full bg-[#0066ff] px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_50px_rgba(0,102,255,0.26)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#0057dc]"
                >
                  Open Quests
                </Link>
              </div>
            </div>

            <MediaSurface
              src="/osss.jpg"
              fallbackSrc="/cofounderpass.png"
              alt="Cofounder pass preview"
              className="min-h-[360px]"
              imageClassName="h-[360px] object-cover object-center"
              fallback={
                <div className="flex h-full min-h-[360px] items-end rounded-[28px] bg-[linear-gradient(180deg,#0f172a_0%,#1d4ed8_50%,#e0f2fe_100%)] p-6">
                  <div className="w-full rounded-[24px] border border-white/20 bg-white/10 p-5 text-white backdrop-blur">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/70">
                      Early path
                    </p>
                    <p className="mt-3 text-2xl font-semibold tracking-[-0.06em]">
                      Cofounder pass quests live inside DustSwap
                    </p>
                  </div>
                </div>
              }
            />
          </div>
        </section>

        <section className="px-4 py-20 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <SectionKicker>Team</SectionKicker>
            <div className="mt-6 max-w-3xl">
              <h2
                className="text-3xl font-semibold tracking-[-0.07em] text-slate-950 sm:text-4xl"
                style={{ fontFamily: "Syne, sans-serif" }}
              >
                Who is behind DustSwap
              </h2>
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              <article className="overflow-hidden rounded-[32px] border border-white/80 bg-white/78 shadow-[0_26px_66px_rgba(148,163,184,0.14)]">
                <MediaSurface
                  src="/Fweb3.jpg"
                  alt="Akbar web3 profile"
                  className="rounded-none border-0 shadow-none"
                  imageClassName="h-[320px] object-cover object-center"
                  fallback={<FounderFallback label="Akbar" tone="web3" />}
                />
                <div className="p-6">
                  <div className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700">
                    Builder and founder
                  </div>
                  <p className="mt-4 text-sm font-medium text-slate-500">web3</p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-[-0.05em] text-slate-950">
                    Akbar
                  </h3>
                  <a
                    href="https://x.com/akbarX402"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex text-sm font-medium text-sky-700 transition-colors hover:text-sky-900"
                  >
                    x.com/akbarX402
                  </a>

                  <div className="mt-6 flex flex-wrap gap-3">
                    <a
                      href="https://x.com/akbarX402"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center rounded-full bg-[#0066ff] px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_50px_rgba(0,102,255,0.24)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#0057dc]"
                    >
                      Contact builder on X
                    </a>
                  </div>
                </div>
              </article>

              <article className="overflow-hidden rounded-[32px] border border-white/80 bg-white/78 shadow-[0_26px_66px_rgba(148,163,184,0.14)]">
                <MediaSurface
                  src="/Fweb2.png"
                  alt="Akbar Hossen profile"
                  className="rounded-none border-0 shadow-none"
                  imageClassName="h-[320px] object-cover object-center"
                  fallback={<FounderFallback label="Akbar Hossen" tone="web2" />}
                />
                <div className="p-6">
                  <div className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-600">
                    Operator
                  </div>
                  <p className="mt-4 text-sm font-medium text-slate-500">web2</p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-[-0.05em] text-slate-950">
                    Akbar Hossen
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-slate-600">
                    Public-facing identity for the person building and running DustSwap.
                  </p>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="px-4 py-20 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl overflow-hidden rounded-[34px] border border-white/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.82),rgba(239,246,255,0.74))] p-6 shadow-[0_28px_72px_rgba(148,163,184,0.16)] backdrop-blur-xl sm:p-8 lg:p-10">
            <SectionKicker>FAQ</SectionKicker>
            <div className="mt-6 max-w-3xl">
              <h2
                className="text-3xl font-semibold tracking-[-0.07em] text-slate-950 sm:text-4xl"
                style={{ fontFamily: "Syne, sans-serif" }}
              >
                Clarity before hype
              </h2>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {FAQ_ITEMS.map((item) => (
                <article
                  key={item.question}
                  className="rounded-[26px] border border-white/90 bg-white/82 p-5 shadow-[0_18px_44px_rgba(148,163,184,0.12)]"
                >
                  <h3 className="text-lg font-semibold tracking-[-0.03em] text-slate-950">
                    {item.question}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-slate-600 sm:text-base">
                    {item.answer}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <footer className="px-4 pb-14 pt-8 sm:px-6 lg:px-8 lg:pb-20">
          <div className="mx-auto flex max-w-6xl flex-col gap-5 rounded-[30px] border border-white/80 bg-white/76 p-6 shadow-[0_24px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-950">DustSwap</p>
              <p className="mt-2 text-sm leading-7 text-slate-500">
                Base activity, quests, streaks, referrals, and leaderboard progress in one live product.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <a
                href="https://x.com/dustswaponbase"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors duration-200 hover:border-sky-200 hover:bg-sky-50 hover:text-slate-950"
              >
                Project X
              </a>
              <a
                href="https://github.com/Hossainraj2002/dustswap"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors duration-200 hover:border-sky-200 hover:bg-sky-50 hover:text-slate-950"
              >
                GitHub
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
