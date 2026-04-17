"use client";

import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";

const SEEN_PREFIX = "dustswap:cofounder-pass-welcome";
const PENDING_PREFIX = "dustswap:cofounder-pass-pending";
const DISMISSED_PREFIX = "dustswap:cofounder-pass-dismissed";

function getSeenKey(address: string) {
  return `${SEEN_PREFIX}:${address.toLowerCase()}`;
}

function getPendingKey(address: string) {
  return `${PENDING_PREFIX}:${address.toLowerCase()}`;
}

function getDismissedKey(address: string) {
  return `${DISMISSED_PREFIX}:${address.toLowerCase()}`;
}

export function CofounderPassWelcomeModal() {
  const router = useRouter();
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const [isOpen, setIsOpen] = useState(false);
  const lastAddressRef = useRef<string | null>(null);

  useEffect(() => {
    if (pathname.startsWith("/admin")) {
      setIsOpen(false);
      return;
    }

    if (!isConnected || !address || typeof window === "undefined") {
      lastAddressRef.current = null;
      setIsOpen(false);
      return;
    }

    const normalizedAddress = address.toLowerCase();
    const isOnProfile = pathname === "/profile" || pathname.startsWith("/profile/");
    const permanentlyDismissed =
      window.localStorage.getItem(getDismissedKey(normalizedAddress)) === "1";

    if (permanentlyDismissed) {
      setIsOpen(false);
      return;
    }

    // Always show on /profile regardless of seen/pending state
    if (isOnProfile) {
      // Reset ref so re-navigating to /profile triggers again
      lastAddressRef.current = null;
      const timer = window.setTimeout(() => {
        setIsOpen(true);
      }, 500);
      return () => window.clearTimeout(timer);
    }

    // On other pages, keep original behaviour: require pending flag, one-time only
    const alreadySeen =
      window.localStorage.getItem(getSeenKey(normalizedAddress)) === "seen";
    const pendingOpen =
      window.localStorage.getItem(getPendingKey(normalizedAddress)) === "pending";

    if (
      alreadySeen ||
      !pendingOpen ||
      lastAddressRef.current === normalizedAddress
    ) {
      return;
    }

    lastAddressRef.current = normalizedAddress;
    const timer = window.setTimeout(() => {
      setIsOpen(true);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [address, isConnected, pathname]);

  function closeModal() {
    if (address && typeof window !== "undefined") {
      const isOnProfile = pathname === "/profile" || pathname.startsWith("/profile/");
      // Only persist "seen" when closing from the one-time referral flow (not /profile)
      if (!isOnProfile) {
        window.localStorage.setItem(getSeenKey(address), "seen");
      }
      window.localStorage.removeItem(getPendingKey(address));
    }
    setIsOpen(false);
  }

  function dismissForever() {
    if (address && typeof window !== "undefined") {
      window.localStorage.setItem(getDismissedKey(address), "1");
      window.localStorage.removeItem(getPendingKey(address));
    }
    setIsOpen(false);
  }

  if (!isOpen || !address) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/42 px-4 backdrop-blur-sm">
      <div className="relative w-full max-w-[296px] overflow-hidden rounded-[24px] border border-white/75 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(239,246,255,0.96))] p-2.5 shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
        <button
          type="button"
          onClick={closeModal}
          className="absolute right-2.5 top-2.5 inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-500 transition hover:text-slate-900"
          aria-label="Close coFounder pass welcome"
        >
          x
        </button>

        <h2 className="mx-auto max-w-[200px] pt-4 text-center text-[20px] font-semibold leading-[1.05] tracking-[-0.04em] text-slate-950">
          coFounder pass is live
        </h2>

        <div className="mt-3 overflow-hidden rounded-[18px] border border-sky-100 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.18),transparent_45%),linear-gradient(180deg,#ffffff,#eff6ff)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
          <Image
            src="/cofounderpass.png"
            alt="DustSwap coFounder pass"
            width={720}
            height={720}
            className="mx-auto h-[138px] w-auto max-w-full rounded-[16px] object-contain"
            priority
          />
        </div>

        <div className="mt-2.5 rounded-[18px] border border-sky-100 bg-white/80 px-3 py-2 text-[11.5px] leading-[1.45] text-slate-600">
          <p>Finish the full coFounder pass quest line to unlock:</p>
          <p className="mt-1">- whitelist for the free mint</p>
          <p>- 30% referral share instead of 20%</p>
        </div>

        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={closeModal}
            className="flex-1 rounded-[18px] border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => {
              closeModal();
              router.push("/quests");
            }}
            className="flex-1 rounded-[18px] bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-700"
          >
            Open Quests
          </button>
        </div>

        <button
          type="button"
          onClick={dismissForever}
          className="mt-1.5 w-full rounded-[16px] px-3 py-2 text-[12px] font-medium text-slate-500 transition hover:text-slate-900"
        >
          Never show again
        </button>
      </div>
    </div>
  );
}
