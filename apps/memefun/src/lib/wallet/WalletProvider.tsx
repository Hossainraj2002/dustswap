"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BASE_CHAIN_ID } from "@/core/constants";
import type { Address } from "@/core/types";
import { usePreview } from "@/lib/preview/scenario";
import { useTheme } from "@/components/theme/ThemeProvider";
import { requestConnectWhenReady, type MemefunWallet } from "./walletState";

export type { MemefunWallet } from "./walletState";

const WalletContext = createContext<MemefunWallet | null>(null);

export const DEMO_ADDRESS = "0x7d3e1f0a5b9c2e8d4f6a1b3c5d7e9f0a2b4c6d8e" as Address;
const DEMO_SESSION_KEY = "memefun:demo-wallet";
const privyConfigured = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim());

/** Loaded after first paint, only when a real wallet is in use. */
const PrivyHost = dynamic(() => import("./PrivyHost"), { ssr: false });

function useRealWalletEnabled() {
  const { preview } = usePreview();
  if (!privyConfigured) return false;
  return !preview || process.env.NEXT_PUBLIC_MEMEFUN_REAL_WALLET === "1";
}

/* --------------------------------------------------------------- demo */

function DemoWalletProvider({ children }: { children: ReactNode }) {
  const { scenario, ready } = usePreview();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [chainId, setChainId] = useState<number>(BASE_CHAIN_ID);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(DEMO_SESSION_KEY);
    } catch {
      stored = null;
    }
    setConnected(scenario === "disconnected" ? false : stored !== "off");
    setChainId(scenario === "wrong-chain" ? 1 : BASE_CHAIN_ID);
  }, [ready, scenario]);

  const connect = useCallback(async () => {
    setConnecting(true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    setConnecting(false);
    setConnected(true);
    try {
      window.sessionStorage.setItem(DEMO_SESSION_KEY, "on");
    } catch {
      // Session storage blocked; the in-memory state still works.
    }
  }, []);

  const disconnect = useCallback(async () => {
    setConnected(false);
    try {
      window.sessionStorage.setItem(DEMO_SESSION_KEY, "off");
    } catch {
      // Ignore.
    }
  }, []);

  const switchToBase = useCallback(async () => {
    setSwitching(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    setChainId(BASE_CHAIN_ID);
    setSwitching(false);
  }, []);

  const value = useMemo<MemefunWallet>(
    () => ({
      mode: "demo",
      status: connected ? "connected" : connecting ? "connecting" : "disconnected",
      address: connected ? DEMO_ADDRESS : null,
      chainId: connected ? chainId : null,
      onBase: connected && chainId === BASE_CHAIN_ID,
      isSwitching: switching,
      connect,
      disconnect,
      switchToBase,
    }),
    [chainId, connect, connected, connecting, disconnect, switchToBase, switching],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/* --------------------------------------------------------------- real */

function RealWalletProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const [hostValue, setHostValue] = useState<MemefunWallet | null>(null);
  const [requested, setRequested] = useState(false);

  const onChange = useCallback((next: MemefunWallet) => setHostValue(next), []);

  // Until the host reports, a Connect tap is remembered and replayed on load.
  const placeholder = useMemo<MemefunWallet>(
    () => ({
      mode: "privy",
      status: requested ? "connecting" : "disconnected",
      address: null,
      chainId: null,
      onBase: false,
      isSwitching: false,
      connect: async () => {
        requestConnectWhenReady();
        setRequested(true);
      },
      disconnect: async () => {},
      switchToBase: async () => {},
    }),
    [requested],
  );

  return (
    <WalletContext.Provider value={hostValue ?? placeholder}>
      {children}
      <PrivyHost theme={resolvedTheme} onChange={onChange} />
    </WalletContext.Provider>
  );
}

/* --------------------------------------------------------------- root */

export function WalletProvider({ children }: { children: ReactNode }) {
  const real = useRealWalletEnabled();
  return real ? <RealWalletProvider>{children}</RealWalletProvider> : <DemoWalletProvider>{children}</DemoWalletProvider>;
}

export function useWallet(): MemefunWallet {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside WalletProvider");
  return context;
}
