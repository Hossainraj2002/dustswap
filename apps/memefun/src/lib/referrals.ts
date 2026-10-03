"use client";

import { useEffect, useState } from "react";
import type { Address } from "@/core/types";

const STORAGE_KEY = "memefun:referrer";

/**
 * First-touch referral: the first ?ref=0x... a visitor arrives with is kept
 * for 30 days and passed as hookData on their trades, so the referrer earns
 * part of the platform share. A wallet can never refer itself.
 */
export function captureReferrer(search: string) {
  const ref = new URLSearchParams(search).get("ref");
  if (!ref || !/^0x[0-9a-fA-F]{40}$/.test(ref)) return;
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) {
      const parsed = JSON.parse(existing) as { address: string; at: number };
      if (Date.now() - parsed.at < 30 * 86_400_000) return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: ref, at: Date.now() }));
  } catch {
    // Storage blocked: referrals simply do not apply.
  }
}

export function readReferrer(self: string | null | undefined): Address | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { address: string; at: number };
    if (Date.now() - parsed.at > 30 * 86_400_000) return undefined;
    if (self && parsed.address.toLowerCase() === self.toLowerCase()) return undefined;
    return parsed.address as Address;
  } catch {
    return undefined;
  }
}

export function useReferrer(self: string | null | undefined): Address | undefined {
  const [referrer, setReferrer] = useState<Address | undefined>(undefined);
  useEffect(() => {
    captureReferrer(window.location.search);
    setReferrer(readReferrer(self));
  }, [self]);
  return referrer;
}

/** Share link that credits `referrer` for trades it brings in. */
export function referralLink(path: string, referrer: string | null | undefined): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://memefun.dustswap.wtf";
  const url = new URL(path, origin);
  if (referrer) url.searchParams.set("ref", referrer);
  return url.toString();
}
