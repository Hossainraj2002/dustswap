'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ComponentType, type ReactNode, type SVGProps } from 'react';
import {
  DustSweepIcon,
  LeaderboardIcon,
  ProfileIcon,
  QuestsIcon,
  SwapIcon,
} from '@/components/NavIcons';
import { CofounderPassWelcomeModal } from '@/components/quests/CofounderPassWelcomeModal';

interface AppShellProps {
  children: ReactNode;
}

interface NavItem {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  route: string;
}

const NAV_ITEMS = [
  { icon: ProfileIcon, label: 'Profile', route: '/profile' },
  { icon: QuestsIcon, label: 'Quests', route: '/quests' },
  { icon: DustSweepIcon, label: 'Dust Sweep', route: '/dustsweep' },
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
      className={`flex h-10 w-10 items-center justify-center rounded-[14px] border transition-all duration-200 ${
        light
          ? active
            ? 'border-sky-200 bg-white text-[#2563eb] shadow-[0_10px_24px_rgba(59,130,246,0.16)]'
            : 'border-slate-200/80 bg-white/85 text-slate-500 shadow-[0_8px_20px_rgba(148,163,184,0.08)] group-hover:border-slate-300 group-hover:text-slate-700'
          : active
            ? 'border-white/15 bg-white/10 text-white shadow-[0_12px_24px_rgba(59,130,246,0.18)]'
            : 'border-white/8 bg-white/[0.04] text-slate-400 group-hover:border-white/14 group-hover:text-white'
      }`}
    >
      <Icon className="h-[18px] w-[18px]" />
    </span>
  );
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const isLightShell = true;

  return (
    <div
      className={`relative flex min-h-screen transition-colors duration-300 ${
        isLightShell ? 'bg-[#f2f6fb] text-slate-900' : 'bg-[#06080d] text-white'
      }`}
    >
      {!isLightShell && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.12),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(14,165,233,0.08),transparent_30%)]"
        />
      )}

      <nav
        className={`fixed inset-y-0 left-0 z-50 hidden w-[236px] flex-col border-r backdrop-blur-2xl md:flex ${
          isLightShell
            ? 'border-slate-200/80 bg-white/78 shadow-[0_24px_80px_rgba(148,163,184,0.16)]'
            : 'border-white/10 bg-[rgba(6,10,18,0.84)]'
        }`}
      >
        <div className="p-6">
          <h1
            className={`text-2xl font-semibold tracking-[-0.06em] ${
              isLightShell
                ? 'bg-gradient-to-r from-slate-950 via-slate-700 to-sky-600 bg-clip-text text-transparent'
                : 'bg-gradient-to-r from-blue-300 via-sky-400 to-blue-500 bg-clip-text text-transparent'
            }`}
            style={{ fontFamily: 'Syne, sans-serif' }}
          >
            DustSwap
          </h1>
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

      <main className="relative z-10 flex-1 pb-[calc(78px+env(safe-area-inset-bottom))] transition-opacity duration-100 ease-in-out md:ml-[236px] md:pb-0">
        <CofounderPassWelcomeModal />
        {children}
      </main>

      <nav
        className={`fixed bottom-0 left-0 right-0 z-50 flex h-[74px] border-t backdrop-blur-2xl md:hidden ${
          isLightShell
            ? 'border-slate-200/80 bg-white/88 shadow-[0_-18px_44px_rgba(148,163,184,0.18)]'
            : 'border-white/10 bg-[rgba(6,10,18,0.9)]'
        }`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV_ITEMS.map((item) => {
          const active = isActiveRoute(pathname, item.route);
          const Icon = item.icon;

          return (
            <Link
              key={item.route}
              href={item.route}
              className="group relative flex flex-1 flex-col items-center justify-center gap-1 active:scale-95 transition-transform"
            >
              <AppShellIcon Icon={Icon} active={active} light={isLightShell} />
              <span
                className={`text-[10px] font-medium tracking-[-0.01em] sm:text-xs ${
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
              {active && (
                <div
                  className={`absolute top-0 h-[3px] w-9 rounded-b-full ${
                    isLightShell
                      ? 'bg-[#2563eb] shadow-[0_0_12px_rgba(37,99,235,0.35)]'
                      : 'bg-[#3b82f6] shadow-[0_0_12px_rgba(59,130,246,0.55)]'
                  }`}
                />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
