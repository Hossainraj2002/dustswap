"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { LiveMarket } from "@/lib/live/LiveMarket";
import { PreviewMarket } from "@/lib/preview/engine";
import { usePreview } from "@/lib/preview/scenario";
import { useWallet } from "@/lib/wallet/WalletProvider";
import type { Market } from "./Market";

interface MarketContextValue {
  market: Market | null;
}

const MarketContext = createContext<MarketContextValue>({ market: null });

/**
 * Owns the market data source: the simulated PreviewMarket in preview, the live API and chain
 * (LiveMarket) on a real deployment. Created on the client after mount so server and client
 * render the same skeleton.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  const { preview, scenario, ready } = usePreview();
  const wallet = useWallet();
  const [market, setMarket] = useState<Market | null>(null);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    let current: Market | null = null;
    const adopt = (next: Market) => {
      if (!active) return;
      current = next;
      next.start();
      setMarket(next);
    };
    if (preview) {
      adopt(new PreviewMarket({ now: Date.now(), empty: scenario === "empty", protectionDemo: scenario === "launch-protection" }));
    } else {
      // The live market (and the chain code behind it) loads only when it is used.
      void import("@/lib/live/LiveMarket").then(({ LiveMarket }) => { if (active) adopt(new LiveMarket()); });
    }
    return () => {
      active = false;
      current?.stop();
    };
  }, [preview, ready, scenario]);

  useEffect(() => {
    if (!market || !wallet.address) return;
    market.ensureUser(
      wallet.address,
      scenario === "insufficient-balance" ? "poor" : scenario === "creator-claimable" ? "creator" : "default",
    );
  }, [market, scenario, wallet.address]);

  const value = useMemo(() => ({ market }), [market]);
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

const noopSubscribe = () => () => {};

/** The market plus a version that bumps on every change, so readers re-render. */
export function useMarket(): { market: Market | null; version: number } {
  const { market } = useContext(MarketContext);
  const version = useSyncExternalStore(
    market ? market.subscribe : noopSubscribe,
    market ? market.getVersion : () => 0,
    () => 0,
  );
  return { market, version };
}

/** The live market when there is one (testnet faucet, admin token), else null. */
export function useLiveMarket(): LiveMarket | null {
  const { market } = useMarket();
  return market?.kind === "live" ? (market as LiveMarket) : null;
}
