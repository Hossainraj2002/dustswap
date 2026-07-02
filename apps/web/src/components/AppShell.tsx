'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAccount } from 'wagmi';
import {
  DustSweepIcon,
  LeaderboardIcon,
  ProfileIcon,
  QuestsIcon,
  SpinIcon,
  SwapIcon,
} from '@/components/NavIcons';
import { ReferralOnboardingModal } from '@/components/referrals/ReferralOnboardingModal';
import { ThemeLongLogo } from '@/components/ThemeLongLogo';
import { useTheme } from '@/components/theme/ThemeProvider';
import { clearPointsSummaryCache, fetchPointsSummary } from '@/lib/points';
import {
  getPendingReferralCode,
  isReferralOnboardingDismissed,
  setReferralOnboardingDismissed,
} from '@/lib/referrals';

interface AppShellProps {
  children: ReactNode;
}

interface NavItem {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  route: string;
  // Core-product tab: rendered as a branded gradient tile with the DustSweep
  // mark instead of the standard outline icon, so it stands out in the nav.
  brand?: boolean;
}

const NAV_ITEMS = [
  { icon: ProfileIcon, label: 'Profile', route: '/profile' },
  { icon: SpinIcon, label: 'Spin', route: '/spin' },
  { icon: DustSweepIcon, label: 'Dust Sweep', route: '/dustsweep', brand: true },
  { icon: SwapIcon, label: 'Swap', route: '/swap' },
  { icon: QuestsIcon, label: 'Quests', route: '/quests' },
  { icon: LeaderboardIcon, label: 'Leaderboard', route: '/leaderboard' },
] satisfies NavItem[];

function isActiveRoute(pathname: string, route: string) {
  return pathname === route || pathname.startsWith(`${route}/`);
}

// Active tab gets a crisp 1px blue outline + soft blue outer glow. Applied via
// inline style (not a `shadow-[...]` class) because a global dark-mode rule in
// globals.css force-normalizes any shadow-[ utility to the standard card
// shadow, which would otherwise swallow this glow.
const ACTIVE_TAB_GLOW = '0 0 0 1px #0052ff, 0 0 8px rgba(0, 82, 255, 0.5)';

function AppShellIcon({
  Icon,
  active,
  light,
  brand,
}: {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  active: boolean;
  light: boolean;
  brand?: boolean;
}) {
  const glowStyle = active ? { boxShadow: ACTIVE_TAB_GLOW } : undefined;
  // Shared tile styling so the brand (Dust Sweep) tab matches every other tab's
  // background + border; only the icon inside differs.
  const tileClassName = `flex h-9 w-9 items-center justify-center rounded-[14px] border transition-all duration-200 md:h-10 md:w-10 ${
    light
      ? active
        ? 'border-sky-200 bg-white text-[#2563eb]'
        : 'border-slate-200/80 bg-white/85 text-slate-500 shadow-[0_8px_20px_rgba(148,163,184,0.08)] group-hover:border-slate-300 group-hover:text-slate-700'
      : active
        ? 'border-white/15 bg-white/10 text-white'
        : 'border-white/8 bg-white/[0.04] text-slate-400 group-hover:border-white/14 group-hover:text-white'
  }`;

  return (
    <span style={glowStyle} className={tileClassName}>
      {brand ? (
        <Image
          src="/dustsweep-mark-blue.png"
          alt=""
          width={24}
          height={24}
          priority
          className="h-[18px] w-[18px] md:h-5 md:w-5"
        />
      ) : (
        <Icon className="h-4 w-4 md:h-[18px] md:w-[18px]" />
      )}
    </span>
  );
}

function MobileShellNav({
  isLightShell,
  pathname,
}: {
  isLightShell: boolean;
  pathname: string;
}) {
  // Bottom navigation only. (A previous "top" placement that flipped the nav to
  // the top of the screen when a browser/wallet bottom bar was detected — e.g.
  // inside Base App — was removed; the nav now always sits at the bottom.)
  const navClassName = `fixed bottom-0 left-0 right-0 z-50 border-t shadow-[0_-18px_44px_rgba(148,163,184,0.16)] backdrop-blur-2xl md:hidden ${
    isLightShell
      ? 'border-slate-200/80 bg-[rgba(255,255,255,0.96)]'
      : 'border-white/10 bg-[rgba(6,10,18,0.9)]'
  }`;
  const navStyle: CSSProperties = { paddingBottom: 'var(--safe-area-bottom)' };
  const navRowClassName =
    'grid h-[69px] w-full grid-cols-6 items-start gap-0.5 px-1 pt-[7px]';
  const navLinkClassName =
    'group flex min-w-0 flex-col items-center justify-start gap-1 transition-transform active:scale-95';

  return (
    <nav className={navClassName} style={navStyle} aria-label="Primary navigation">
      <div className={navRowClassName}>
        {NAV_ITEMS.map((item) => {
          const active = isActiveRoute(pathname, item.route);
          const Icon = item.icon;

          return (
            <Link
              key={item.route}
              href={item.route}
              className={navLinkClassName}
            >
              <AppShellIcon
                Icon={Icon}
                active={active}
                light={isLightShell}
                brand={item.brand}
              />
              <span
                className={`min-w-0 text-center text-[9px] font-medium leading-[1.1] tracking-[-0.02em] sm:text-[11px] ${
                  isLightShell
                    ? active
                      ? 'text-slate-950'
                      : 'text-slate-500'
                    : active
                      ? 'text-white'
                      : 'text-slate-500'
                }`}
                style={{ fontFamily: 'DM Sans, sans-serif' }}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      const hasInjected = !!(
        (window as any).ethereum ||
        (window as any).web3 ||
        (window as any).trustWallet ||
        (window as any).okxwallet ||
        (window as any).rainbow
      );
      const hasWalletUA = /Coinbase|Rainbow|MetaMask|OKApp|TokenPocket/i.test(navigator.userAgent);
      if (isMobile && (hasInjected || hasWalletUA)) {
        document.documentElement.style.setProperty('--safe-area-bottom', '0px');
      }
    }
  }, []);
  const isLightShell = resolvedTheme === 'light';
  const isLandingPage = pathname === '/';
  const isMaintenancePage = pathname === '/maintenance';
  const isShelllessPage = isMaintenancePage;
  const { address, isConnected } = useAccount();
  const [showReferralModal, setShowReferralModal] = useState(false);
  const checkedRef = useRef<string | null>(null);

  const checkReferralEligibility = useCallback(async (addr: string) => {
    if (typeof window === 'undefined') return;
    if (getPendingReferralCode()) return;
    if (isReferralOnboardingDismissed(addr)) return;

    try {
      const summary = await fetchPointsSummary(addr);
      if (summary?.success && summary.referral?.hasReferrer === false) {
        setShowReferralModal(true);
      }
    } catch {
      // Keep the shell resilient even if the profile summary request fails.
    }
  }, []);

  useEffect(() => {
    if (
      isLandingPage ||
      isShelllessPage ||
      pathname === '/profile' ||
      pathname.startsWith('/profile/') ||
      pathname.startsWith('/admin') ||
      pathname.startsWith('/partner') ||
      pathname.startsWith('/ref/')
    ) {
      checkedRef.current = null;
      setShowReferralModal(false);
      return;
    }

    if (!isConnected || !address) {
      checkedRef.current = null;
      setShowReferralModal(false);
      return;
    }

    const normalizedAddress = address.toLowerCase();
    if (checkedRef.current === normalizedAddress) return;
    checkedRef.current = normalizedAddress;

    const timerId = window.setTimeout(
      () => void checkReferralEligibility(address),
      1200
    );

    return () => window.clearTimeout(timerId);
  }, [
    address,
    checkReferralEligibility,
    isLandingPage,
    isConnected,
    isShelllessPage,
    pathname,
  ]);

  const handleReferralApplied = useCallback(() => {
    setShowReferralModal(false);
    if (address) {
      clearPointsSummaryCache(address);
    }
  }, [address]);

  const handleReferralDismiss = useCallback(() => {
    if (address) {
      setReferralOnboardingDismissed(address);
    }
    setShowReferralModal(false);
  }, [address]);

  const rootStyle = {
    '--ds-mobile-fixed-bottom-offset': 'calc(77px + var(--safe-area-bottom))',
  } as CSSProperties;
  const mainShellClassName = isShelllessPage
    ? ''
    : 'pb-[calc(77px+var(--safe-area-bottom))] md:ml-[236px] md:pb-0';

  return (
    <div
      className={`relative flex min-h-screen transition-colors duration-300 ${
        isLightShell ? 'bg-[#f2f6fb] text-slate-900' : 'bg-[#07111f] text-white'
      }`}
      style={rootStyle}
      data-shell-mode="bottom"
    >
      {!isLightShell && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.16),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(99,102,241,0.12),transparent_30%),linear-gradient(180deg,#07111f,#081321)]"
        />
      )}

      {!isShelllessPage && (
        <nav
          className={`fixed inset-y-0 left-0 z-50 hidden w-[236px] flex-col border-r backdrop-blur-2xl md:flex ${
            isLightShell
              ? 'border-slate-200/80 bg-white/78 shadow-[0_24px_80px_rgba(148,163,184,0.16)]'
              : 'border-white/10 bg-[rgba(6,10,18,0.84)]'
          }`}
        >
          <div className="p-6">
            <Link
              href="/profile"
              className={`inline-flex rounded-[22px] border px-4 py-3 transition-transform duration-200 hover:-translate-y-0.5 ${
                isLightShell
                  ? 'border-white/70 bg-white/90 shadow-[0_16px_36px_rgba(148,163,184,0.16)]'
                  : 'border-white/10 bg-white/[0.06] shadow-[0_18px_48px_rgba(0,0,0,0.28)]'
              }`}
              aria-label="DustSwap app"
            >
              <ThemeLongLogo
                alt="DustSwap"
                width={170}
                height={42}
                className="h-auto w-[138px]"
                priority
              />
            </Link>
          </div>

          <div className="mt-2 flex-1 space-y-2 px-4">
            {NAV_ITEMS.map((item) => {
              const active = isActiveRoute(pathname, item.route);
              const Icon = item.icon;

              return (
                <Link
                  key={item.route}
                  href={item.route}
                  className={`group flex items-center gap-3 rounded-[18px] px-3 py-3 transition-all duration-200 ${
                    isLightShell
                      ? active
                        ? 'bg-sky-50/85 text-slate-950'
                        : 'text-slate-500 hover:bg-slate-100/80 hover:text-slate-900'
                      : active
                        ? 'bg-white/[0.06] text-white'
                        : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'
                  }`}
                >
                  <AppShellIcon
                    Icon={Icon}
                    active={active}
                    light={isLightShell}
                    brand={item.brand}
                  />
                  <span
                    className="font-medium tracking-[-0.02em]"
                    style={{ fontFamily: 'DM Sans, sans-serif' }}
                  >
                    {item.label}
                  </span>
                  {active && (
                    <span
                      className={`ml-auto h-2 w-2 rounded-full ${
                        isLightShell ? 'bg-[#2563eb]' : 'bg-blue-400'
                      }`}
                    />
                  )}
                </Link>
              );
            })}
          </div>
        </nav>
      )}

      <main
        className={`relative z-10 flex-1 transition-opacity duration-100 ease-in-out ${mainShellClassName}`}
      >
        {children}
      </main>

      {!isShelllessPage && (
        <MobileShellNav isLightShell={isLightShell} pathname={pathname} />
      )}

      {showReferralModal && address && (
        <ReferralOnboardingModal
          address={address}
          onApplied={handleReferralApplied}
          onDismiss={handleReferralDismiss}
        />
      )}
    </div>
  );
}
