"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useWalletConnection } from "@/hooks/useWalletConnection";

type WalletConnectButtonProps = {
  className?: string;
  connectLabel?: string;
  connectedLabel?: string;
  description?: string;
  fullWidth?: boolean;
  showDisconnect?: boolean;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const DEFAULT_BUTTON_CLASS_NAME =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-[0_10px_24px_rgba(148,163,184,0.12)] transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50 hover:text-slate-900 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-100 dark:shadow-[0_16px_40px_rgba(0,0,0,0.26)] dark:hover:border-sky-400/40 dark:hover:bg-sky-400/10 dark:hover:text-white";
const CUSTOM_BUTTON_BASE_CLASS_NAME =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-200";

export function WalletConnectButton({
  className,
  connectLabel = "Connect wallet",
  connectedLabel,
  description,
  fullWidth = false,
  showDisconnect = false,
}: WalletConnectButtonProps) {
  const { address, isConnected } = useAccount();
  const { disconnectWallet, openWalletModal } = useWalletConnection();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!isConnected) {
      setMenuOpen(false);
    }
  }, [isConnected]);

  const label =
    isConnected && address
      ? connectedLabel ?? shortAddress(address)
      : connectLabel;

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!isConnected) {
            void openWalletModal(description);
            return;
          }

          if (showDisconnect) {
            setMenuOpen((current) => !current);
          }
        }}
        className={cx(
          className ? CUSTOM_BUTTON_BASE_CLASS_NAME : DEFAULT_BUTTON_CLASS_NAME,
          fullWidth && "w-full",
          className
        )}
        aria-expanded={showDisconnect ? menuOpen : undefined}
        aria-haspopup={showDisconnect ? "menu" : undefined}
      >
        <span
          className={cx(
            "h-2 w-2 rounded-full",
            isConnected ? "bg-emerald-400" : "bg-sky-300"
          )}
          aria-hidden="true"
        />
        <span>{label}</span>
      </button>

      {showDisconnect && isConnected && address && menuOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-[80] min-w-[220px] rounded-[20px] border border-slate-200 bg-white p-2 shadow-[0_22px_48px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-[#0b1220] dark:shadow-[0_24px_60px_rgba(0,0,0,0.36)]"
        >
          <div className="rounded-[16px] bg-slate-50 px-3 py-2 dark:bg-white/[0.06]">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400 dark:text-slate-500">
              Connected
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
              {shortAddress(address)}
            </p>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void disconnectWallet();
            }}
            className="mt-2 flex w-full items-center justify-center rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:border-rose-400/40 dark:hover:bg-rose-400/10 dark:hover:text-rose-200"
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
