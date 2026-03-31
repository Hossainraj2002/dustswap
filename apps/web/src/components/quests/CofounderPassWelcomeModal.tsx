"use client";

import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";

const SEEN_PREFIX = "dustswap:cofounder-pass-welcome";
const PENDING_PREFIX = "dustswap:cofounder-pass-pending";

function getSeenKey(address: string) {
  return `${SEEN_PREFIX}:${address.toLowerCase()}`;
}

function getPendingKey(address: string) {
  return `${PENDING_PREFIX}:${address.toLowerCase()}`;
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
      window.localStorage.setItem(getSeenKey(address), "seen");
      window.localStorage.removeItem(getPendingKey(address));
    }
    setIsOpen(false);
  }

  if (!isOpen || !address) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/42 px-4 backdrop-blur-sm">
      <div className="relative w-full max-w-[320px] overflow-hidden rounded-[28px] border border-white/75 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(239,246,255,0.96))] p-3 shadow-[0_28px_80px_rgba(15,23,42,0.24)]">
        <button
          type="button"
          onClick={closeModal}
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-500 transition hover:text-slate-900"
          aria-label="Close coFounder pass welcome"
        >
          x
        </button>

        <p className="text-center text-[10px] font-semibold uppercase tracking-[0.28em] text-sky-700/70">
          coFounder Pass
        </p>
        <h2 className="mt-2 text-center text-[24px] font-semibold tracking-[-0.04em] text-slate-950">
          Welcome to DustSwap
        </h2>
        <p className="mx-auto mt-2 max-w-[260px] text-center text-[13px] leading-5 text-slate-600">
          To celebrate our launch and honor our early users, we are giving away
          the coFounder pass for free. Complete every coFounder pass quest and
          get whitelisted for the mint.
        </p>

        <div className="mt-3 overflow-hidden rounded-[22px] border border-sky-100 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.18),transparent_45%),linear-gradient(180deg,#ffffff,#eff6ff)] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
          <Image
            src="/cofounderpass.png"
            alt="DustSwap coFounder pass"
            width={720}
            height={720}
            className="mx-auto h-[170px] w-auto max-w-full rounded-[18px] object-contain"
            priority
          />
        </div>

        <div className="mt-3 rounded-[20px] border border-sky-100 bg-white/80 px-3 py-2.5 text-[12px] leading-5 text-slate-600">
          <p>Finish the full coFounder pass quest line to unlock:</p>
          <p className="mt-1">- whitelist for the free mint</p>
          <p>- 6.9% of our token after TGE</p>
          <p>- 30% referral share instead of 20%</p>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={closeModal}
            className="flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => {
              closeModal();
              router.push("/quests");
            }}
            className="flex-1 rounded-2xl bg-sky-600 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700"
          >
            Open Quests
          </button>
        </div>
      </div>
    </div>
  );
}
