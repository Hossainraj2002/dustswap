"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { WalletButton } from "./WalletButton";

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Extra controls next to the wallet button. */
  actions?: ReactNode;
  /** Hide the wallet button (rare). */
  hideWallet?: boolean;
  /** Leading control in the compact bar, e.g. a back button. */
  leading?: ReactNode;
}

/**
 * HIG navigation bar with a large title. The large title scrolls with the
 * content; once it is gone a compact translucent bar with the inline title
 * fades in at the top (compact widths only).
 */
export function PageHeader({ title, subtitle, actions, hideWallet = false, leading }: PageHeaderProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setCompact(entry ? !entry.isIntersecting : false), {
      rootMargin: "-8px 0px 0px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const trailing = (
    <div className="flex shrink-0 items-center gap-2">
      {actions}
      {hideWallet ? null : <WalletButton />}
    </div>
  );

  return (
    <>
      <div
        aria-hidden={!compact}
        className={cn(
          "mf-material hairline-b fixed inset-x-0 top-0 z-30 flex items-center gap-3 px-4 transition-opacity duration-200 lg:hidden",
          compact ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        style={{ paddingTop: "var(--mf-safe-top)", height: "calc(52px + var(--mf-safe-top))" }}
      >
        <div className="flex w-20 items-center">{leading}</div>
        <span className="min-w-0 flex-1 truncate text-center text-headline text-label">{title}</span>
        <div className="flex w-20 justify-end">{hideWallet ? null : <WalletButton />}</div>
      </div>
      <header className="flex flex-col gap-1 pb-4 pt-[max(16px,var(--mf-safe-top))] lg:pt-6">
        {leading ? <div className="-ml-2 mb-1 lg:hidden">{leading}</div> : null}
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 text-large-title text-label">{title}</h1>
          <div className="pt-1">{trailing}</div>
        </div>
        {subtitle ? <div className="text-subhead text-label-2">{subtitle}</div> : null}
        <div ref={sentinel} aria-hidden className="h-px" />
      </header>
    </>
  );
}
