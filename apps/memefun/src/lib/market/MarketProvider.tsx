"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { PreviewMarket } from "@/lib/preview/engine";
import { usePreview } from "@/lib/preview/scenario";
import { useWallet } from "@/lib/wallet/WalletProvider";

interface MarketContextValue {
  market: PreviewMarket | null;
}

const MarketContext = createContext<MarketContextValue>({ market: null });

/**
 * Owns the market data source. In preview it is the simulated PreviewMarket;
 * Phase 4 provides the live indexer source with the same interface. Created on
 * the client after mount so server and client render the same skeleton.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  const { scenario, ready } = usePreview();
  const wallet = useWallet();
  const [market, setMarket] = useState<PreviewMarket | null>(null);

  useEffect(() => {
    if (!ready) return;
    const next = new PreviewMarket({
      now: Date.now(),
      empty: scenario === "empty",
      protectionDemo: scenario === "launch-protection",
    });
    next.start();
    setMarket(next);
    return () => next.stop();
  }, [ready, scenario]);

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
export function useMarket(): { market: PreviewMarket | null; version: number } {
  const { market } = useContext(MarketContext);
  const version = useSyncExternalStore(
    market ? market.subscribe : noopSubscribe,
    market ? market.getVersion : () => 0,
    () => 0,
  );
  return { market, version };
}
