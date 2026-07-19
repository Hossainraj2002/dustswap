"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { subscribeToSwapTamperWarning } from "@/lib/clientEvents";
import {
  detectPocketUniverse,
  isPocketUniverseGateEnabled,
  observePocketUniverse,
} from "@/lib/pocketUniverseDetect";
import { BASE_CHAIN_ID, NATIVE_ETH, USDC_ADDRESS } from "@/lib/tokens";

const OPENOCEAN_REFERRER_ADDRESS =
  process.env.NEXT_PUBLIC_OPENOCEAN_REFERRER_ADDRESS ||
  "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573";

const WIDGET_BASE_CONFIG = {
  variant: "compact",
  subvariant: "default",
  slippage: 0.03,
  fromChain: BASE_CHAIN_ID,
  toChain: BASE_CHAIN_ID,
  fromToken: NATIVE_ETH,
  toToken: USDC_ADDRESS,
  defaultChain: BASE_CHAIN_ID,
  defaultFromToken: NATIVE_ETH,
  defaultToToken: USDC_ADDRESS,
} as const;

const DUSTSWAP_OPENOCEAN_DARK_THEME = {
  palette: {
    primary: {
      main: "#0052ff",
    },
    secondary: {
      main: "#38bdf8",
    },
    background: {
      default: "#222037",
      paper: "#29273D",
    },
    text: {
      primary: "#ffffff",
      secondary: "#8C7F8C",
    },
    grey: {
      200: "#EEEFF2",
      300: "#D5DAE1",
      700: "#555B62",
      800: "#373F48",
    },
  },
  shape: {
    borderRadius: 12,
    borderRadiusSecondary: 12,
    borderRadiusTertiary: 24,
  },
  typography: {
    fontFamily: "Inter, sans-serif",
  },
  container: {
    boxShadow: "0px 8px 32px rgba(0, 0, 0, 0.08)",
    borderRadius: "16px",
  },
  playground: {
    background: "#17122B",
  },
  components: {
    MuiCard: {
      defaultProps: { variant: "filled" },
    },
    MuiTabs: {
      styleOverrides: {
        root: {
          backgroundColor: "#29273D",
          ".MuiTabs-indicator": {
            backgroundColor: "#17122b",
          },
        },
      },
    },
  },
} as const;

function OpenOceanWidgetLoading() {
  return (
    <div className="w-full rounded-[16px] bg-white p-6 shadow-[0px_8px_32px_rgba(0,0,0,0.08)] dark:border dark:border-white/10 dark:bg-[rgba(11,18,32,0.9)] dark:shadow-[0_24px_80px_rgba(0,0,0,0.34)]">
      <div className="mb-8 h-8 w-24 rounded-xl bg-slate-100 dark:bg-white/10" />
      <div className="space-y-5">
        <div className="h-28 rounded-2xl bg-slate-100 dark:bg-white/10" />
        <div className="mx-auto h-11 w-11 rounded-full bg-slate-100 dark:bg-white/10" />
        <div className="h-28 rounded-2xl bg-slate-100 dark:bg-white/10" />
        <div className="h-16 rounded-2xl bg-sky-100 dark:bg-sky-400/15" />
      </div>
      <div className="mx-auto mt-8 h-4 w-40 rounded-full bg-slate-100 dark:bg-white/10" />
    </div>
  );
}

const OpenOceanWidget = dynamic<{ integrator: string; config: any }>(
  () => import("@openocean.finance/widget").then((mod) => mod.OpenOceanWidget as any),
  {
    ssr: false,
    loading: () => <OpenOceanWidgetLoading />,
  }
);

function PocketUniverseGate({
  onRecheck,
  isRechecking,
}: {
  onRecheck: () => void;
  isRechecking: boolean;
}) {
  return (
    <div className="mx-auto w-full max-w-[440px] px-3 sm:px-0">
      <div className="rounded-[24px] border border-rose-200 bg-white p-6 shadow-[0_24px_80px_rgba(190,18,60,0.12)] dark:border-rose-400/30 dark:bg-[rgba(11,18,32,0.92)]">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-100 text-xl dark:bg-rose-500/15">
            🛑
          </div>
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-rose-600 dark:text-rose-300">
              Swap paused
            </p>
            <h2 className="text-lg font-black tracking-tight text-slate-950 dark:text-white">
              Pocket Universe is active
            </h2>
          </div>
        </div>

        <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
          Pocket Universe modifies swaps in your browser — it replaces DustSwap&apos;s fee
          routing with its own address and adds a 0.8% charge. Swaps made while it&apos;s on are{" "}
          <span className="font-semibold text-slate-900 dark:text-white">not tracked</span>: they
          don&apos;t count toward your volume, quests, or rewards, and part of your funds is diverted.
        </p>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/5">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            To continue
          </p>
          <ol className="mt-2 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
            <li>1. Open your browser extensions and turn off <span className="font-semibold">Pocket Universe</span> (or disable it for this site).</li>
            <li>2. Press <span className="font-semibold">Re-check</span> below.</li>
          </ol>
        </div>

        <button
          type="button"
          onClick={onRecheck}
          disabled={isRechecking}
          className="mt-5 flex w-full items-center justify-center rounded-[16px] bg-[linear-gradient(135deg,#2563eb,#0ea5e9)] px-5 py-3 text-base font-black text-white shadow-[0_16px_34px_rgba(37,99,235,0.24)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRechecking ? "Reloading…" : "Re-check"}
        </button>

        <p className="mt-3 text-center text-xs text-slate-400 dark:text-slate-500">
          Re-check reloads the page. This lock only applies to the Swap page.
        </p>
      </div>
    </div>
  );
}

export default function SwapPageClient() {
  const { openWalletModal } = useWalletConnection();
  const { resolvedTheme } = useTheme();

  // Pocket Universe gate. PU injects beneath the app and diverts swap fees, so a
  // calldata guard can't stop it — instead we detect PU and lock the widget until
  // it's disabled. Detection is passive (see pocketUniverseDetect.ts) and folds in
  // the server's on-chain hijack signal. Detection re-runs fresh on every mount,
  // so a reload after disabling PU clears the lock.
  const [puBlocked, setPuBlocked] = useState(false);
  const [isRechecking, setIsRechecking] = useState(false);

  const gateEnabled = isPocketUniverseGateEnabled();

  useEffect(() => {
    if (!gateEnabled) {
      return;
    }

    if (detectPocketUniverse().detected) {
      setPuBlocked(true);
    }

    const stopObserving = observePocketUniverse(() => setPuBlocked(true));
    const unsubscribe = subscribeToSwapTamperWarning(() => setPuBlocked(true));

    return () => {
      stopObserving();
      unsubscribe();
    };
  }, [gateEnabled]);

  const recheckPocketUniverse = useCallback(() => {
    setIsRechecking(true);
    // Disabling an extension does NOT remove hooks it already injected into this
    // page — only a reload does. Reload, then detection re-runs fresh on mount:
    // if PU is gone the page loads normally, otherwise the gate re-engages.
    window.location.reload();
  }, []);

  const config = useMemo(
    () => ({
      ...WIDGET_BASE_CONFIG,
      // Use OpenOcean's official mode/theme API with only DustSwap's blue accent changed.
      appearance: resolvedTheme,
      theme: resolvedTheme === "dark" ? DUSTSWAP_OPENOCEAN_DARK_THEME : undefined,
      referrer: {
        address: OPENOCEAN_REFERRER_ADDRESS,
        fee: "0.25",
      },
      walletConfig: {
        onConnect: () => {
          void openWalletModal("Connect your wallet to swap on DustSwap.");
        },
        usePartialWalletManagement: true,
      },
    }),
    [openWalletModal, resolvedTheme]
  );

  return (
    <main
      className="flex flex-col items-center justify-center overflow-x-hidden bg-transparent px-0 py-6 sm:px-4 sm:py-8"
      style={{ minHeight: "calc(100dvh - 100px)" }}
    >
      {gateEnabled && puBlocked ? (
        <PocketUniverseGate
          onRecheck={recheckPocketUniverse}
          isRechecking={isRechecking}
        />
      ) : (
        <div className="mx-auto flex w-full max-w-[420px] justify-center">
          <div className="dustswap-openocean-widget w-full min-w-0">
            <OpenOceanWidget
              key={resolvedTheme}
              integrator="DustSwap"
              config={config as any}
            />
          </div>
        </div>
      )}
      <style jsx global>{`
        @media (max-width: 640px) {
          .dustswap-openocean-widget .MuiInputAdornment-positionEnd {
            margin-left: 8px;
            align-self: center;
          }

          .dustswap-openocean-widget .MuiInputAdornment-positionEnd .MuiButtonBase-root,
          .dustswap-openocean-widget .MuiInputAdornment-positionEnd .MuiButton-root,
          .dustswap-openocean-widget .MuiInputAdornment-positionEnd button {
            min-width: 0 !important;
            min-height: 0 !important;
            width: auto !important;
            height: 32px !important;
            padding: 0 10px !important;
            border-radius: 10px !important;
            font-size: 11px !important;
            line-height: 1 !important;
          }

          .dustswap-openocean-widget .MuiFormHelperText-root {
            margin-left: 0 !important;
            white-space: nowrap !important;
          }
        }
      `}</style>
    </main>
  );
}
