'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ReactNode } from 'react';

interface AppShellProps {
  children: ReactNode;
}

const NAV_ITEMS = [
  { icon: '👤', label: 'Profile', route: '/profile' },
  { icon: '⚡', label: 'Quests', route: '/quests' },
  { icon: '🌪️', label: 'DustSweep', route: '/dustsweep' },
  { icon: '🔄', label: 'Swap', route: '/swap' },
  { icon: '🔥', label: 'Burn', route: '/burn' },
];

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen bg-[#0a0a0f] text-white">
      {/* Desktop Sidebar (hidden on mobile, fixed left on desktop) */}
      <nav className="hidden md:flex flex-col fixed inset-y-0 left-0 w-[220px] bg-[rgba(255,255,255,0.05)] border-r border-[rgba(255,255,255,0.08)] backdrop-blur-[20px] z-50">
        <div className="p-6">
          <h1 className="text-2xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-blue-600" style={{ fontFamily: 'Syne, sans-serif' }}>
            DustSwap
          </h1>
        </div>
        <div className="flex-1 px-4 space-y-2 mt-4">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname.startsWith(item.route);
            return (
              <Link
                key={item.route}
                href={item.route}
                className={`flex items-center gap-3 px-4 py-3 rounded-[12px] transition-all duration-100 ${
                  isActive
                    ? 'bg-blue-500/10 text-[#3b82f6] shadow-[0_0_10px_rgba(59,130,246,0.3)]'
                    : 'text-gray-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <span className="text-xl">{item.icon}</span>
                <span className="font-medium" style={{ fontFamily: 'DM Sans, sans-serif' }}>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Main Content Area (shifts right on desktop) */}
      <main className="flex-1 md:ml-[220px] pb-[calc(64px+env(safe-area-inset-bottom))] md:pb-0 transition-opacity duration-100 ease-in-out">
        {children}
      </main>

      {/* Mobile Bottom Navigation (hidden on desktop, fixed bottom on mobile) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-[64px] bg-[rgba(255,255,255,0.05)] border-t border-[rgba(255,255,255,0.08)] backdrop-blur-[20px] z-50 flex" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.route);
          return (
            <Link
              key={item.route}
              href={item.route}
              className="flex-1 flex flex-col items-center justify-center gap-1 active:scale-95 transition-transform"
            >
              <span className={`text-xl transition-colors ${isActive ? 'text-[#3b82f6] drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]' : 'text-gray-500 grayscale'}`}>
                {item.icon}
              </span>
              <span className={`text-[10px] sm:text-xs font-medium ${isActive ? 'text-white' : 'text-gray-500'}`} style={{ fontFamily: 'DM Sans, sans-serif' }}>
                {item.label}
              </span>
              {isActive && (
                <div className="absolute top-0 w-8 h-[2px] bg-[#3b82f6] shadow-[0_0_10px_rgba(59,130,246,0.8)] rounded-b-full"></div>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
