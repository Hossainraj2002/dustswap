"use client";

import { useEffect, useState } from "react";
import { TARGET_CHAIN_ID } from "@/lib/chain";
import { createApi } from "@/lib/live/api";
import { API_URL } from "@/lib/live/config";
import { usePreview } from "@/lib/preview/scenario";
import { parsePlatformTokenInfo, type PlatformTokenInfo } from "./config";

/** The server verifies the signed selection and original on-chain launcher. */
export function usePlatformToken() {
  const { preview, ready } = usePreview();
  const [info, setInfo] = useState<PlatformTokenInfo | null>(null);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!ready || preview || TARGET_CHAIN_ID !== 8453 || !API_URL) return;
    const api = createApi(API_URL);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const hidden = () => document.visibilityState === "hidden";
    const poll = async () => {
      if (pending || controller.signal.aborted || hidden()) return;
      pending = true;
      let interval = 5_000;
      try {
        const next = parsePlatformTokenInfo(await api.get("/v1/platform-token", { signal: controller.signal }));
        // Once the official token is pinned its identity is stable; token prices use LiveMarket.
        if (next?.enabled && next.tokenAddress) interval = 60_000;
        if (!controller.signal.aborted) { setInfo(next); setAvailable(true); }
      } catch {
        // Keep the last response for recovery; selection and official badges require available.
        if (!controller.signal.aborted) setAvailable(false);
      } finally {
        pending = false;
        if (!controller.signal.aborted && !hidden()) timer = setTimeout(() => void poll(), interval);
      }
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      if (!hidden()) void poll();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [preview, ready]);
  return { info, available, showAnnouncement: ready && !preview && TARGET_CHAIN_ID === 8453 };
}
