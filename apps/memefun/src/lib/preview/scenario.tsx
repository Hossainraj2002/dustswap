"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Preview mode renders every screen from a simulated market so the product
 * can be reviewed before contracts exist. It is on while no factory address
 * is configured, or when NEXT_PUBLIC_MEMEFUN_PREVIEW is "1", so it cannot
 * reach production by accident once a real deployment is set.
 */
export function isPreviewMode(): boolean {
  if (process.env.NEXT_PUBLIC_MEMEFUN_PREVIEW === "1") return true;
  return !/^0x[0-9a-fA-F]{40}$/.test(process.env.NEXT_PUBLIC_MEMEFUN_FACTORY_ADDRESS ?? "");
}

export const SCENARIOS = [
  { id: "default", label: "Live market", group: "Market" },
  { id: "empty", label: "No coins yet", group: "Market" },
  { id: "launch-protection", label: "Coin in launch protection", group: "Market" },
  { id: "burn-mode", label: "Buyback and burn coin", group: "Coins" },
  { id: "holder-mode", label: "Holder rewards coin", group: "Coins" },
  { id: "floor-mode", label: "Liquidity floor coin", group: "Coins" },
  { id: "usdc-pair", label: "USDC pair", group: "Coins" },
  { id: "stock-pair", label: "Stock pair", group: "Coins" },
  { id: "disconnected", label: "Wallet not connected", group: "Wallet" },
  { id: "wrong-chain", label: "Wrong network", group: "Wallet" },
  { id: "insufficient-balance", label: "Low balance", group: "Wallet" },
  { id: "creator-claimable", label: "Creator with earnings", group: "Wallet" },
  { id: "tx-rejected", label: "Rejected in wallet", group: "Transactions" },
  { id: "tx-failed", label: "Transaction fails", group: "Transactions" },
  { id: "stock-restricted", label: "Stock pairs restricted", group: "Access" },
  { id: "admin", label: "Admin settings", group: "Access" },
] as const;

export type ScenarioId = (typeof SCENARIOS)[number]["id"];

const SCENARIO_IDS = new Set<string>(SCENARIOS.map((scenario) => scenario.id));
const SCENARIO_SESSION_KEY = "memefun:scenario";

interface PreviewContextValue {
  preview: boolean;
  scenario: ScenarioId;
  /** Becomes true once the URL scenario has been adopted on the client. */
  ready: boolean;
  setScenario: (scenario: ScenarioId) => void;
  /** Transaction outcome forced by the scenario. */
  txOutcome: "ok" | "rejected" | "reverted";
  stocksRestricted: boolean;
}

const PreviewContext = createContext<PreviewContextValue>({
  preview: false,
  scenario: "default",
  ready: true,
  setScenario: () => {},
  txOutcome: "ok",
  stocksRestricted: false,
});

export function PreviewProvider({ children }: { children: ReactNode }) {
  const preview = isPreviewMode();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [scenario, setScenarioState] = useState<ScenarioId>("default");
  const [ready, setReady] = useState(!preview);

  // Adopt the scenario after mount, never in initial state (hydration). A
  // ?scenario= link wins; otherwise the session's scenario persists across
  // navigation, so moving between pages never rebuilds the market.
  const urlScenario = searchParams.get("scenario");
  useEffect(() => {
    if (!preview) return;
    let next: ScenarioId = "default";
    if (urlScenario && SCENARIO_IDS.has(urlScenario)) {
      next = urlScenario as ScenarioId;
    } else {
      try {
        const stored = window.sessionStorage.getItem(SCENARIO_SESSION_KEY);
        if (stored && SCENARIO_IDS.has(stored)) next = stored as ScenarioId;
      } catch {
        // Storage blocked; fall back to the default scenario.
      }
    }
    setScenarioState((current) => (current === next ? current : next));
    try {
      window.sessionStorage.setItem(SCENARIO_SESSION_KEY, next);
    } catch {
      // Ignore.
    }
    setReady(true);
  }, [preview, urlScenario]);

  const setScenario = useCallback(
    (next: ScenarioId) => {
      setScenarioState(next);
      try {
        window.sessionStorage.setItem(SCENARIO_SESSION_KEY, next);
      } catch {
        // Ignore.
      }
      const params = new URLSearchParams(searchParams.toString());
      if (next === "default") params.delete("scenario");
      else params.set("scenario", next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const value = useMemo<PreviewContextValue>(
    () => ({
      preview,
      scenario,
      ready,
      setScenario,
      txOutcome: scenario === "tx-rejected" ? "rejected" : scenario === "tx-failed" ? "reverted" : "ok",
      stocksRestricted: scenario === "stock-restricted",
    }),
    [preview, ready, scenario, setScenario],
  );

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function usePreview() {
  return useContext(PreviewContext);
}
