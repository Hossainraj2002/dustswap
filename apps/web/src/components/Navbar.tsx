"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
} from "@coinbase/onchainkit/wallet";
import {
  Address,
  Avatar,
  Name,
  Identity,
} from "@coinbase/onchainkit/identity";
import { base } from "wagmi/chains";

interface NavLink {
  href: string;
  label: string;
  badge?: string;
  icon: string;
}

const NAV_LINKS: NavLink[] = [
  { href: "/", label: "Home", icon: "🏠" },
  { href: "/dust-sweep", label: "Dust Sweep", icon: "🧹" },
  { href: "/swap", label: "Swap", icon: "🔄" },
  { href: "/burn", label: "Burn", icon: "🔥" },
  { href: "/dust-bridge", label: "Bridge", icon: "🌉", badge: "Soon" },
  { href: "/particles", label: "Particles", icon: "✨" },
];

interface PointsData {
  totalPoints: number;
}

export function Navbar() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [particleCount, setParticleCount] = useState<number>(0);
  const [pointsLoading, setPointsLoading] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const fetchPoints = useCallback(async () => {
    if (!address) {
      setParticleCount(0);
      return;
    }

    setPointsLoading(true);
    try {
      const response = await fetch(`${apiUrl}/api/points/${address}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        setParticleCount(0);
        return;
      }

      const data: PointsData = await response.json();
      setParticleCount(data.totalPoints ?? 0);
    } catch {
      setParticleCount(0);
    } finally {
      setPointsLoading(false);
    }
  }, [address, apiUrl]);

  useEffect(() => {
    fetchPoints();

    if (!address) return;

    const interval = setInterval(fetchPoints, 60000);
    return () => clearInterval(interval);
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
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
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
        className="sticky top-0 z-50 w-full border-b border-gray-800 bg-gray-900/80 backdrop-blur-xl"
        role="navigation"
        aria-label="Main navigation"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            {/* Logo */}
            <Link
              href="/"
              className="group flex shrink-0 items-center gap-2 transition-opacity duration-200 hover:opacity-80"
              aria-label="DustSwap home"
            >
              <span
                className="text-2xl transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110"
                aria-hidden="true"
              >
                ✨
              </span>
              <span className="bg-gradient-to-r from-[#8B5CF6] to-[#6366F1] bg-clip-text text-xl font-bold text-transparent">
                DustSwap
              </span>
            </Link>

            {/* Desktop navigation links */}
            <div className="hidden items-center gap-1 lg:flex">
              {NAV_LINKS.map((link) => {
                const active = isActive(link.href);
                const isDisabled = link.badge === "Soon";

                if (isDisabled) {
                  return (
                    <span
                      key={link.href}
                      className="relative flex cursor-not-allowed items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors duration-200"
                      title="Coming soon"
                    >
                      <span className="text-sm" aria-hidden="true">
                        {link.icon}
                      </span>
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
                        : "text-gray-400 hover:bg-white/5 hover:text-white"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="text-sm" aria-hidden="true">
                      {link.icon}
                    </span>
                    <span>{link.label}</span>

                    {/* Particles link: show count when connected */}
                    {link.href === "/particles" &&
                      isConnected &&
                      !pointsLoading && (
                        <span className="ml-1 rounded-full bg-[#8B5CF6]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#8B5CF6]">
                          {formatNumber(particleCount)}
                        </span>
                      )}

                    {/* Active indicator underline */}
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

            {/* Right section: particle count + wallet + hamburger */}
            <div className="flex items-center gap-3">
              {/* Particle balance pill (desktop) */}
              {isConnected && (
                <Link
                  href="/particles"
                  className="hidden items-center gap-1.5 rounded-full border border-[#8B5CF6]/20 bg-[#8B5CF6]/10 px-3 py-1.5 text-sm font-medium text-[#8B5CF6] transition-all duration-200 hover:border-[#8B5CF6]/40 hover:bg-[#8B5CF6]/20 sm:flex"
                  title="Your Dust Particles"
                >
                  <span aria-hidden="true">✨</span>
                  {pointsLoading ? (
                    <span className="inline-block h-3.5 w-8 animate-pulse rounded bg-[#8B5CF6]/20" />
                  ) : (
                    <span>{formatNumber(particleCount)}</span>
                  )}
                </Link>
              )}

              {/* OnchainKit Wallet */}
              <Wallet>
                <ConnectWallet
                  className="!rounded-xl !border !border-[#8B5CF6]/30 !bg-[#8B5CF6]/10 !px-4 !py-2 !text-sm !font-semibold !text-[#8B5CF6] !shadow-none !transition-all !duration-200 hover:!border-[#8B5CF6]/50 hover:!bg-[#8B5CF6]/20"
                >
                  <Avatar className="h-5 w-5" />
                  <Name className="max-w-[120px] truncate" />
                </ConnectWallet>
                <WalletDropdown>
                  <Identity
                    className="px-4 pb-2 pt-3"
                    hasCopyAddressOnClick={true}
                    schemaId="0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9"
                  >
                    <Avatar className="h-10 w-10" />
                    <Name className="text-sm font-semibold" />
                    <Address className="text-xs text-gray-400" />
                  </Identity>
                  <WalletDropdownDisconnect className="text-sm text-red-400 hover:text-red-300" />
                </WalletDropdown>
              </Wallet>

              {/* Mobile hamburger button */}
              <button
                ref={hamburgerRef}
                type="button"
                onClick={() => setMobileMenuOpen((prev) => !prev)}
                className="relative flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors duration-200 hover:bg-white/5 hover:text-white lg:hidden"
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

      {/* Mobile menu overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 lg:hidden ${
          mobileMenuOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        aria-hidden="true"
        onClick={() => setMobileMenuOpen(false)}
      />

      {/* Mobile slide-out panel */}
      <div
        ref={mobileMenuRef}
        id="mobile-menu"
        role="dialog"
        aria-modal={mobileMenuOpen}
        aria-label="Mobile navigation"
        className={`fixed right-0 top-0 z-50 flex h-full w-72 flex-col border-l border-gray-800 bg-gray-900/95 backdrop-blur-xl transition-transform duration-300 ease-out lg:hidden ${
          mobileMenuOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Mobile menu header */}
        <div className="flex h-16 items-center justify-between border-b border-gray-800 px-4">
          <span className="bg-gradient-to-r from-[#8B5CF6] to-[#6366F1] bg-clip-text text-lg font-bold text-transparent">
            ✨ DustSwap
          </span>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
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

        {/* Particle balance card (mobile) */}
        {isConnected && (
          <div className="border-b border-gray-800 px-4 py-3">
            <Link
              href="/particles"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-between rounded-xl border border-[#8B5CF6]/20 bg-[#8B5CF6]/5 px-4 py-3 transition-colors duration-200 hover:bg-[#8B5CF6]/10"
            >
              <div className="flex items-center gap-2">
                <span className="text-lg" aria-hidden="true">
                  ✨
                </span>
                <span className="text-sm font-medium text-gray-300">
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

        {/* Mobile navigation links */}
        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Mobile navigation">
          <ul className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => {
              const active = isActive(link.href);
              const isDisabled = link.badge === "Soon";

              return (
                <li key={link.href}>
                  {isDisabled ? (
                    <span className="flex cursor-not-allowed items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-gray-600">
                      <span className="text-base" aria-hidden="true">
                        {link.icon}
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
                          : "text-gray-400 hover:bg-white/5 hover:text-white"
                      }`}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className="text-base" aria-hidden="true">
                        {link.icon}
                      </span>
                      <span className="flex-1">{link.label}</span>

                      {link.href === "/particles" &&
                        isConnected &&
                        !pointsLoading && (
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

        {/* Mobile menu footer */}
        <div className="border-t border-gray-800 px-4 py-4">
          <div className="text-center text-xs text-gray-600">
            Built on Base · Powered by Coinbase Smart Wallet
          </div>
        </div>
      </div>
    </>
  );
}