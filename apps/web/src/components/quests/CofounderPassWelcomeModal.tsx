"use client";

import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";

const STORAGE_PREFIX = "dustswap:cofounder-pass-welcome";

function getStorageKey(address: string) {
  return `${STORAGE_PREFIX}:${address.toLowerCase()}`;
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

    if (!isConnected || !address) {
      lastAddressRef.current = null;
      setIsOpen(false);
      return;
    }

    const normalizedAddress = address.toLowerCase();
    const storageKey = getStorageKey(normalizedAddress);
    const alreadySeen =
      typeof window !== "undefined" &&
      window.localStorage.getItem(storageKey) === "seen";

    if (alreadySeen || lastAddressRef.current === normalizedAddress) {
      return;
    }

    lastAddressRef.current = normalizedAddress;
    const timer = window.setTimeout(() => {
      setIsOpen(true);
    }, 550);

    return () => window.clearTimeout(timer);
  }, [address, isConnected, pathname]);

  function closeModal() {
    if (address && typeof window !== "undefined") {
      window.localStorage.setItem(getStorageKey(address), "seen");
    }
    setIsOpen(false);
  }

  if (!isOpen || !address) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden rounded-[30px] border border-white/75 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(239,246,255,0.96))] p-4 shadow-[0_32px_90px_rgba(15,23,42,0.26)]">
        <button
          type="button"
          onClick={closeModal}
          className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:text-slate-900"
          aria-label="Close coFounder pass welcome"
        >
          ×
        </button>

        <p className="text-center text-[11px] font-semibold uppercase tracking-[0.32em] text-sky-700/70">
          coFounder Pass
        </p>
        <h2 className="mt-3 text-center text-[28px] font-semibold tracking-[-0.04em] text-slate-950">
          Welcome to DustSwap
        </h2>
        <p className="mx-auto mt-3 max-w-sm text-center text-sm leading-6 text-slate-600">
          To celebrate our launch and honor our early users, we are giving away
          the coFounder pass for free. Complete every coFounder pass quest and
          get whitelisted for the mint.
        </p>

        <div className="mt-5 overflow-hidden rounded-[26px] border border-sky-100 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.18),transparent_45%),linear-gradient(180deg,#ffffff,#eff6ff)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
          <Image
            src="/cofounderpass.png"
            alt="DustSwap coFounder pass"
            width={720}
            height={720}
            className="h-auto w-full rounded-[22px] object-cover"
            priority
          />
        </div>

        <div className="mt-5 rounded-[24px] border border-sky-100 bg-white/80 px-4 py-3 text-sm leading-6 text-slate-600">
          <p>Finish the full coFounder pass quest line to unlock:</p>
          <p className="mt-2">• whitelist for the free mint</p>
          <p>• 6.9% of our token after TGE</p>
          <p>• 30% of your invited user points instead of 20%</p>
        </div>

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={closeModal}
            className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => {
              closeModal();
              router.push("/quests");
            }}
            className="flex-1 rounded-2xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-700"
          >
            Open Quests
          </button>
        </div>
      </div>
    </div>
  );
}
