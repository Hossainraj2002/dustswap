"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import {
  DustSweepIcon,
  HomeIcon,
  LeaderboardIcon,
  ParticlesIcon,
  QuestsIcon,
  SpinIcon,
  SwapIcon,
} from "@/components/NavIcons";
import { WalletConnectButton } from "@/components/wallet/WalletConnectButton";
import { subscribeToDataInvalidation } from "@/lib/clientEvents";
import { fetchPointsSummary } from "@/lib/points";

interface NavLink {
  href: string;
  label: string;
  badge?: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const NAV_LINKS: NavLink[] = [
  { href: "/quests", label: "Quests", icon: QuestsIcon },
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/spin", label: "Spin", icon: SpinIcon },
  { href: "/comingsoon", label: "Dust Sweep", icon: DustSweepIcon },
  { href: "/swap", label: "Swap & Bridge", icon: SwapIcon },
  { href: "/leaderboard", label: "Leaderboard", icon: LeaderboardIcon },
  { href: "/particles", label: "Particles", icon: ParticlesIcon },
];

interface PointsData {
  totalPoints: number;
}

function NavBadgeIcon({
  Icon,
  active,
}: {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  active?: boolean;
}) {
  return (
    <span
      className={`flex h-8 w-8 items-center justify-center rounded-xl border ${
        active
          ? "border-[#8B5CF6]/25 bg-[#8B5CF6]/10 text-[#8B5CF6]"
          : "border-slate-200 bg-white text-slate-500"
      }`}
      aria-hidden="true"
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

export function Navbar() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [particleCount, setParticleCount] = useState<number>(0);
  const [pointsLoading, setPointsLoading] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const fetchPoints = useCallback(async (options?: { force?: boolean }) => {
    if (!address) {
      setParticleCount(0);
      return;
    }

    setPointsLoading(true);
    try {
      const response = await fetchPointsSummary(address, {
        force: options?.force,
      });
      if (!response.success) {
        setParticleCount(0);
        return;
      }

      const data: PointsData = response.balance;
      setParticleCount(data.totalPoints ?? 0);
    } catch {
      setParticleCount(0);
    } finally {
      setPointsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void fetchPoints();
  }, [fetchPoints]);

  useEffect(() => {
    if (!address) {
      return;
    }

    const unsubscribe = subscribeToDataInvalidation("points", () => {
      void fetchPoints({ force: true });
    });
    const handleFocus = () => {
      void fetchPoints({ force: true });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchPoints({ force: true });
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchPoints, address]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        mobileMenuRef.current &&
        !mobileMenuRef.current.contains(target) &&
        hamburgerRef.current &&
        !hamburgerRef.current.contains(target)
      ) {
        setMobileMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  function isActive(href: string): boolean {
    if (href === "/") {
      return pathname === "/";
    }

    return pathname.startsWith(href);
  }

  function formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }

    if (num >= 1_000) {
      return num.toLocaleString("en-US");
    }

    return num.toString();
  }

  return (
    <>
      <nav
        className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur-xl"
        role="navigation"
        aria-label="Main navigation"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <Link
              href="/"
              className="group flex shrink-0 items-center gap-2 transition-opacity duration-200 hover:opacity-80"
              aria-label="DustSwap home"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-2xl border border-slate-200 bg-white text-[#8B5CF6] transition-transform duration-300 group-hover:scale-105">
                <ParticlesIcon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="bg-gradient-to-r from-[#8B5CF6] to-[#6366F1] bg-clip-text text-xl font-bold text-transparent">
                DustSwap
              </span>
            </Link>

            <div className="hidden items-center gap-1 lg:flex">
              {NAV_LINKS.map((link) => {
                const active = isActive(link.href);
                const isDisabled = link.badge === "Soon";

                if (isDisabled) {
                  return (
                    <span
                      key={link.href}
                      className="relative flex cursor-not-allowed items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-400"
                      title="Coming soon"
                    >
                      <NavBadgeIcon Icon={link.icon} />
                      <span>{link.label}</span>
                      <span className="ml-1 rounded-full bg-[#8B5CF6]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#8B5CF6]">
                        Soon
                      </span>
                    </span>
                  );
                }

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`relative flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-200 ${
                      active
                        ? "text-[#8B5CF6]"
                        : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    <NavBadgeIcon Icon={link.icon} active={active} />
                    <span>{link.label}</span>

                    {link.href === "/particles" && isConnected && !pointsLoading && (
                      <span className="ml-1 rounded-full bg-[#8B5CF6]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#8B5CF6]">
                        {formatNumber(particleCount)}
                      </span>
                    )}

                    {active && (
                      <span
                        className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full bg-[#8B5CF6]"
                        aria-hidden="true"
                      />
                    )}
                  </Link>
                );
              })}
            </div>

            <div className="flex items-center gap-3">
              {isConnected && (
                <Link
                  href="/particles"
                  className="hidden items-center gap-1.5 rounded-full border border-[#8B5CF6]/20 bg-[#8B5CF6]/10 px-3 py-1.5 text-sm font-medium text-[#8B5CF6] transition-all duration-200 hover:border-[#8B5CF6]/40 hover:bg-[#8B5CF6]/20 sm:flex"
                  title="Your Dust Particles"
                >
                  <ParticlesIcon className="h-4 w-4" aria-hidden="true" />
                  {pointsLoading ? (
                    <span className="inline-block h-3.5 w-8 animate-pulse rounded bg-[#8B5CF6]/20" />
                  ) : (
                    <span>{formatNumber(particleCount)}</span>
                  )}
                </Link>
              )}

              <WalletConnectButton
                className="inline-flex min-h-[40px] items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-[0_10px_24px_rgba(148,163,184,0.12)] transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-900"
                description="Connect your wallet to use DustSwap."
                showDisconnect
              />

              <button
                ref={hamburgerRef}
                type="button"
                onClick={() => setMobileMenuOpen((prev) => !prev)}
                className="relative flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors duration-200 hover:bg-slate-50 hover:text-slate-900 lg:hidden"
                aria-expanded={mobileMenuOpen}
                aria-controls="mobile-menu"
                aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              >
                <div className="flex w-5 flex-col items-center gap-[5px]">
                  <span
                    className={`block h-[2px] w-5 rounded-full bg-current transition-all duration-300 ${
                      mobileMenuOpen
                        ? "translate-y-[7px] rotate-45"
                        : "translate-y-0 rotate-0"
                    }`}
                  />
                  <span
                    className={`block h-[2px] w-5 rounded-full bg-current transition-all duration-300 ${
                      mobileMenuOpen ? "opacity-0" : "opacity-100"
                    }`}
                  />
                  <span
                    className={`block h-[2px] w-5 rounded-full bg-current transition-all duration-300 ${
                      mobileMenuOpen
                        ? "-translate-y-[7px] -rotate-45"
                        : "translate-y-0 rotate-0"
                    }`}
                  />
                </div>
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div
        className={`fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-300 lg:hidden ${
          mobileMenuOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        aria-hidden="true"
        onClick={() => setMobileMenuOpen(false)}
      />

      <div
        ref={mobileMenuRef}
        id="mobile-menu"
        role="dialog"
        aria-modal={mobileMenuOpen}
        aria-label="Mobile navigation"
        className={`fixed right-0 top-0 z-50 flex h-full w-72 flex-col border-l border-slate-200 bg-white/95 backdrop-blur-xl transition-transform duration-300 ease-out lg:hidden ${
          mobileMenuOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-4">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl border border-slate-200 bg-white text-[#8B5CF6]">
              <ParticlesIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="bg-gradient-to-r from-[#8B5CF6] to-[#6366F1] bg-clip-text text-lg font-bold text-transparent">
              DustSwap
            </span>
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
            aria-label="Close menu"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {isConnected && (
          <div className="border-b border-slate-200 px-4 py-3">
            <Link
              href="/particles"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-between rounded-xl border border-[#8B5CF6]/20 bg-[#8B5CF6]/5 px-4 py-3 transition-colors duration-200 hover:bg-[#8B5CF6]/10"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#8B5CF6]/20 bg-[#8B5CF6]/10 text-[#8B5CF6]">
                  <ParticlesIcon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="text-sm font-medium text-slate-600">
                  Dust Particles
                </span>
              </div>
              {pointsLoading ? (
                <span className="inline-block h-4 w-12 animate-pulse rounded bg-[#8B5CF6]/20" />
              ) : (
                <span className="text-sm font-bold text-[#8B5CF6]">
                  {formatNumber(particleCount)}
                </span>
              )}
            </Link>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Mobile navigation">
          <ul className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => {
              const active = isActive(link.href);
              const isDisabled = link.badge === "Soon";

              return (
                <li key={link.href}>
                  {isDisabled ? (
                    <span className="flex cursor-not-allowed items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-slate-400">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400">
                        <link.icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">{link.label}</span>
                      <span className="rounded-full bg-[#8B5CF6]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#8B5CF6]">
                        Soon
                      </span>
                    </span>
                  ) : (
                    <Link
                      href={link.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors duration-200 ${
                        active
                          ? "border border-[#8B5CF6]/20 bg-[#8B5CF6]/10 text-[#8B5CF6]"
                          : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                      }`}
                      aria-current={active ? "page" : undefined}
                    >
                      <span
                        className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
                          active
                            ? "border-[#8B5CF6]/25 bg-[#8B5CF6]/10 text-[#8B5CF6]"
                            : "border-slate-200 bg-white text-slate-500"
                        }`}
                      >
                        <link.icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">{link.label}</span>

                      {link.href === "/particles" && isConnected && !pointsLoading && (
                        <span className="rounded-full bg-[#8B5CF6]/15 px-2 py-0.5 text-[10px] font-semibold text-[#8B5CF6]">
                          {formatNumber(particleCount)}
                        </span>
                      )}

                      {active && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-[#8B5CF6]"
                          aria-hidden="true"
                        />
                      )}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-slate-200 px-4 py-4">
          <div className="text-center text-xs text-slate-500">
            Built on Base | Powered by Coinbase Smart Wallet
          </div>
        </div>
      </div>
    </>
  );
}
