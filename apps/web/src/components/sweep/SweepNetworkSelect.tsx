"use client";

import { useEffect, useId, useRef, useState } from "react";
import { type SweepChain } from "@/config/sweepChainConfig";
import { SweepNetworkIcon } from "@/components/sweep/SweepNetworkIcon";

export function SweepNetworkSelect({
  chains,
  chainId,
  onChainChange,
  disabled,
}: {
  chains: SweepChain[];
  chainId: number;
  onChainChange: (chainId: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, chains.findIndex((chain) => chain.id === chainId));
  const activeChain = chains[activeIndex];

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, activeIndex]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (chains.length < 2 || !activeChain) return null;

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="shrink-0 sm:relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          closeAndFocus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        title={activeChain.label}
        aria-label={`Select network, current network: ${activeChain.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-slate-200/80 bg-white/80 shadow-sm transition hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/10 dark:focus-visible:ring-offset-slate-900"
      >
        <SweepNetworkIcon chainId={activeChain.id} decorative />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Select sweep network"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-[80] w-52 rounded-[16px] border border-slate-200 bg-white p-1.5 shadow-[0_18px_48px_rgba(15,23,42,0.18)] dark:border-white/10 dark:bg-[#0b1220]"
        >
          {chains.map((chain, index) => {
            const active = chain.id === chainId;
            return (
              <button
                ref={(element) => { itemRefs.current[index] = element; }}
                key={chain.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                tabIndex={-1}
                onKeyDown={(event) => {
                  let nextIndex: number | undefined;
                  if (event.key === "ArrowDown") nextIndex = (index + 1) % chains.length;
                  if (event.key === "ArrowUp") nextIndex = (index - 1 + chains.length) % chains.length;
                  if (event.key === "Home") nextIndex = 0;
                  if (event.key === "End") nextIndex = chains.length - 1;
                  if (nextIndex !== undefined) {
                    event.preventDefault();
                    itemRefs.current[nextIndex]?.focus();
                  }
                  if (event.key === "Tab") closeAndFocus();
                }}
                onClick={() => {
                  if (!active) onChainChange(chain.id);
                  closeAndFocus();
                }}
                className={`flex min-h-11 w-full items-center gap-3 rounded-[11px] px-3 py-2 text-left text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${active
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300"
                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-white/[0.06]"}`}
              >
                <SweepNetworkIcon chainId={chain.id} className="h-5 w-5" decorative />
                <span className="flex-1 whitespace-nowrap">{chain.label}</span>
                {active ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
