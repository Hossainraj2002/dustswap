"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Plus, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { BrandWordmark } from "./Brand";
import { SIDEBAR_ITEMS, TAB_ITEMS } from "./nav";
import { LiveBar } from "./LiveBar";
import { PreviewBar } from "./PreviewBar";
import { SearchCommand, useSearchShortcut } from "./SearchCommand";
import { ThemeSegmented } from "./ThemeSegmented";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  useSearchShortcut(() => setSearchOpen(true));

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="fixed left-4 top-4 z-[100] -translate-y-[200%] rounded-full bg-tint-fill px-4 py-2.5 text-subhead font-semibold text-on-tint shadow-float transition-transform focus:translate-y-0 motion-reduce:transition-none"
      >
        Skip to content
      </a>
      <Sidebar pathname={pathname} onSearch={() => setSearchOpen(true)} />
      <div className="lg:pl-[268px]">
        <div className="lg:px-6 lg:pt-3">
          <PreviewBar />
          <LiveBar />
        </div>
        <main
          id="main"
          className="mx-auto w-full max-w-[1280px] px-4 pb-[calc(var(--mf-tabbar-height)+40px+var(--mf-safe-bottom))] sm:px-5 lg:px-8 lg:pb-16"
        >
          {children}
        </main>
      </div>
      <TabBar pathname={pathname} />
      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

function Sidebar({ pathname, onSearch }: { pathname: string; onSearch: () => void }) {
  const [shortcut, setShortcut] = useState("Ctrl K");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut("⌘K");
  }, []);

  return (
    <aside
      aria-label="Main"
      className="mf-glass fixed bottom-3 left-3 top-3 z-40 hidden w-[244px] flex-col rounded-xl p-3 lg:flex mf-squircle"
    >
      <Link href="/" className="mb-4 flex h-11 items-center rounded-md px-2" aria-label="memefun home">
        <BrandWordmark />
      </Link>
      <Button asChild size="md" fullWidth className="mb-3">
        <Link href="/create">
          <Plus className="size-5" aria-hidden />
          Create coin
        </Link>
      </Button>
      <button
        type="button"
        onClick={onSearch}
        className="mb-2 flex h-10 items-center gap-2 rounded-sm bg-fill-3 px-3 text-left text-subhead text-label-2 transition-colors hover:bg-fill-2"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1">Search coins</span>
        <kbd className="rounded-[6px] bg-fill-3 px-1.5 py-0.5 font-sans text-caption1 font-semibold text-label-2">{shortcut}</kbd>
      </button>
      <nav className="flex flex-col gap-0.5">
        {SIDEBAR_ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-11 items-center gap-3 rounded-sm px-3 text-body transition-colors",
                active ? "bg-tint/10 font-semibold text-tint" : "text-label hover:bg-fill-4",
              )}
            >
              <Icon className="size-5" strokeWidth={active ? 2.3 : 1.9} aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-3">
        <ThemeSegmented size="sm" iconOnly />
        <a
          href="https://app.dustswap.wtf"
          className="flex h-9 items-center justify-between rounded-sm px-3 text-footnote font-semibold text-label-2 transition-colors hover:bg-fill-4 hover:text-label"
        >
          Open DustSwap
          <ArrowUpRight className="size-4" aria-hidden />
        </a>
      </div>
    </aside>
  );
}

function TabBar({ pathname }: { pathname: string }) {
  // Coin pages and the launch flow hide the tab bar on phones and show their
  // own action bar, like a detail screen or a focused task in an iOS app.
  if (pathname.startsWith("/t/") || pathname.startsWith("/create")) return null;
  return (
    <nav
      aria-label="Tabs"
      className="fixed inset-x-3 z-40 lg:hidden"
      style={{ bottom: "max(12px, calc(var(--mf-safe-bottom) + 4px))" }}
    >
      <ul className="mf-glass mf-glass-dense mx-auto grid h-[var(--mf-tabbar-height)] max-w-md grid-cols-5 items-center rounded-full px-1.5">
        {TAB_ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          if (item.prominent) {
            return (
              <li key={item.href} className="flex justify-center">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-label="Create coin"
                  className="flex size-12 items-center justify-center rounded-full bg-tint-fill text-on-tint shadow-[0_6px_16px_rgba(0,82,255,0.35)] transition-transform active:scale-95"
                >
                  <Icon className="size-6" strokeWidth={2.5} aria-hidden />
                </Link>
              </li>
            );
          }
          return (
            <li key={item.href} className="flex justify-center">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-[52px] w-full flex-col items-center justify-center gap-0.5 rounded-full text-caption2 font-semibold transition-colors",
                  active ? "bg-fill-3 text-tint" : "text-label-2",
                )}
              >
                <Icon className="size-[22px]" strokeWidth={active ? 2.3 : 1.9} aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
