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
  HomeIcon,
  LeaderboardIcon,
  ProfileIcon,
  QuestsIcon,
  SpinIcon,
  SwapIcon,
} from '@/components/NavIcons';
import { ReferralOnboardingModal } from '@/components/referrals/ReferralOnboardingModal';
import { useAppShellMode } from '@/hooks/useAppShellMode';
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
}

const NAV_ITEMS = [
  { icon: HomeIcon, label: 'Airdrop', route: '/' },
  { icon: ProfileIcon, label: 'Profile', route: '/profile' },
  { icon: SpinIcon, label: 'Spin', route: '/spin' },
  { icon: QuestsIcon, label: 'Quests', route: '/quests' },
  { icon: SwapIcon, label: 'Swap', route: '/swap' },
  { icon: LeaderboardIcon, label: 'Leaderboard', route: '/leaderboard' },
] satisfies NavItem[];

function isActiveRoute(pathname: string, route: string) {
  return pathname === route || pathname.startsWith(`${route}/`);
}

function AppShellIcon({
  Icon,
  active,
  light,
}: {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  active: boolean;
  light: boolean;
}) {
  return (
    <span
      className={`flex h-9 w-9 items-center justify-center rounded-[14px] border transition-all duration-200 md:h-10 md:w-10 ${
        light
          ? active
            ? 'border-sky-200 bg-white text-[#2563eb] shadow-[0_10px_24px_rgba(59,130,246,0.16)]'
            : 'border-slate-200/80 bg-white/85 text-slate-500 shadow-[0_8px_20px_rgba(148,163,184,0.08)] group-hover:border-slate-300 group-hover:text-slate-700'
          : active
            ? 'border-white/15 bg-white/10 text-white shadow-[0_12px_24px_rgba(59,130,246,0.18)]'
            : 'border-white/8 bg-white/[0.04] text-slate-400 group-hover:border-white/14 group-hover:text-white'
      }`}
    >
      <Icon className="h-4 w-4 md:h-[18px] md:w-[18px]" />
    </span>
  );
}

function MobileShellNav({
  isLightShell,
  pathname,
  placement,
}: {
  isLightShell: boolean;
  pathname: string;
  placement: 'bottom' | 'top';
}) {
  const isTopNav = placement === 'top';
  const navClassName = `fixed left-0 right-0 z-50 backdrop-blur-2xl md:hidden ${
    isTopNav
      ? 'top-0'
      : 'bottom-0 border-t shadow-[0_-18px_44px_rgba(148,163,184,0.16)]'
  } ${
    isLightShell
      ? isTopNav
        ? 'bg-[rgba(255,255,255,0.96)] shadow-[inset_0_-1px_0_rgba(226,232,240,0.8),0_18px_44px_rgba(148,163,184,0.14)]'
        : 'border-slate-200/80 bg-[rgba(255,255,255,0.96)]'
      : isTopNav
        ? 'bg-[rgba(6,10,18,0.9)] shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)]'
        : 'border-white/10 bg-[rgba(6,10,18,0.9)]'
  }`;
  const navStyle: CSSProperties = isTopNav
    ? {
        height: 'calc(60px + env(safe-area-inset-top))',
        paddingTop: 'env(safe-area-inset-top)',
      }
    : { paddingBottom: 'env(safe-area-inset-bottom)' };
  const navRowClassName = isTopNav
    ? 'grid h-[60px] w-full grid-cols-6 items-center gap-1 px-2'
    : 'grid h-[82px] w-full grid-cols-6 items-start gap-1 px-2 pt-3';
  const navLinkClassName = isTopNav
    ? 'group flex min-w-0 flex-col items-center justify-center gap-1 transition-transform active:scale-95'
    : 'group flex min-w-0 flex-col items-center justify-start gap-2 transition-transform active:scale-95';

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
              <AppShellIcon Icon={Icon} active={active} light={isLightShell} />
              <span
                className={`min-w-0 text-center text-[10px] font-medium leading-none tracking-[-0.01em] sm:text-xs ${
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
  const isLightShell = true;
  const isLandingPage = pathname === '/';
  const isMaintenancePage = pathname === '/maintenance';
  const isShelllessPage = isMaintenancePage;
  const shellMode = useAppShellMode({ enabled: !isShelllessPage });
  const isTopNavMobileMode = shellMode === 'top';
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
    '--ds-mobile-fixed-bottom-offset': isTopNavMobileMode
      ? 'env(safe-area-inset-bottom)'
      : 'calc(90px + env(safe-area-inset-bottom))',
  } as CSSProperties;
  const mainShellClassName = isShelllessPage
    ? ''
    : isTopNavMobileMode
      ? 'pt-[calc(60px+env(safe-area-inset-top))] md:ml-[236px] md:pt-0'
      : 'pb-[calc(90px+env(safe-area-inset-bottom))] md:ml-[236px] md:pb-0';

  return (
    <div
      className={`relative flex min-h-screen transition-colors duration-300 ${
        isLightShell ? 'bg-[#f2f6fb] text-slate-900' : 'bg-[#06080d] text-white'
      }`}
      style={rootStyle}
      data-shell-mode={shellMode}
    >
      {!isLightShell && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.12),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(14,165,233,0.08),transparent_30%)]"
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
              href="/"
              className="inline-flex rounded-[22px] border border-white/70 bg-white/90 px-4 py-3 shadow-[0_16px_36px_rgba(148,163,184,0.16)] transition-transform duration-200 hover:-translate-y-0.5"
              aria-label="DustSwap home"
            >
              <Image
                src="/longlogo.png"
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
                  <AppShellIcon Icon={Icon} active={active} light={isLightShell} />
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

      {!isShelllessPage && isTopNavMobileMode && (
        <MobileShellNav
          isLightShell={isLightShell}
          pathname={pathname}
          placement="top"
        />
      )}

      <main
        className={`relative z-10 flex-1 transition-opacity duration-100 ease-in-out ${mainShellClassName}`}
      >
        {showReferralModal && address && (
          <ReferralOnboardingModal
            address={address}
            onApplied={handleReferralApplied}
            onDismiss={handleReferralDismiss}
          />
        )}
        {children}
      </main>

      {!isShelllessPage && !isTopNavMobileMode && (
        <MobileShellNav
          isLightShell={isLightShell}
          pathname={pathname}
          placement="bottom"
        />
      )}
    </div>
  );
}
