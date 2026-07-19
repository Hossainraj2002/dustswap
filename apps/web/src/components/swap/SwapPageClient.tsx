"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useWalletConnection } from "@/hooks/useWalletConnection";
import { subscribeToSwapTamperWarning } from "@/lib/clientEvents";
import { BASE_CHAIN_ID, NATIVE_ETH, USDC_ADDRESS } from "@/lib/tokens";

const SWAP_TAMPER_SESSION_KEY = "dustswap.swap.tamperWarning";

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

export default function SwapPageClient() {
  const { openWalletModal } = useWalletConnection();
  const { resolvedTheme } = useTheme();

  // Fee-theft warning: a browser extension (e.g. Pocket Universe) rewrote the
  // OpenOcean referrer. The banner persists (per session) until dismissed; a
  // toast flashes on each new detection.
  const [tamperBannerVisible, setTamperBannerVisible] = useState(false);
  const [tamperToastVisible, setTamperToastVisible] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        if (window.sessionStorage.getItem(SWAP_TAMPER_SESSION_KEY) === "1") {
          setTamperBannerVisible(true);
        }
      } catch {
        // sessionStorage may be unavailable (private mode) — non-fatal.
      }
    }

    let toastTimer: number | undefined;
    const unsubscribe = subscribeToSwapTamperWarning(() => {
      setTamperBannerVisible(true);
      setTamperToastVisible(true);
      try {
        window.sessionStorage.setItem(SWAP_TAMPER_SESSION_KEY, "1");
      } catch {
        // ignore storage failures
      }
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => setTamperToastVisible(false), 7000);
    });

    return () => {
      window.clearTimeout(toastTimer);
      unsubscribe();
    };
  }, []);

  const dismissTamperBanner = useCallback(() => {
    setTamperBannerVisible(false);
    setTamperToastVisible(false);
    try {
      window.sessionStorage.removeItem(SWAP_TAMPER_SESSION_KEY);
    } catch {
      // ignore storage failures
    }
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
      {tamperBannerVisible ? (
        <div className="mx-auto mb-4 w-full max-w-[420px] px-3 sm:px-0">
          <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 shadow-[0_10px_30px_rgba(245,158,11,0.15)] dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-100">
            <div className="flex items-start gap-3">
              <span aria-hidden className="mt-0.5 text-lg leading-none">⚠️</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold">A browser extension is redirecting your swap fees</p>
                <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-200/90">
                  We detected that an extension such as <span className="font-semibold">Pocket Universe</span> replaced
                  DustSwap&apos;s referrer on your swap and diverted the fee to itself. Disable it for
                  {" "}
                  <span className="font-semibold">app.dustswap.wtf</span>, then refresh and swap again to stay protected.
                </p>
              </div>
              <button
                type="button"
                onClick={dismissTamperBanner}
                className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/15"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tamperToastVisible ? (
        <div className="pointer-events-none fixed inset-x-0 top-4 z-[80] flex justify-center px-4">
          <div className="pointer-events-auto max-w-md rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900 shadow-[0_16px_40px_rgba(15,23,42,0.18)] dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-100">
            ⚠️ A browser extension redirected your swap fee — please disable it.
          </div>
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-[420px] justify-center">
        <div className="dustswap-openocean-widget w-full min-w-0">
          <OpenOceanWidget
            key={resolvedTheme}
            integrator="DustSwap"
            config={config as any}
          />
        </div>
      </div>
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
