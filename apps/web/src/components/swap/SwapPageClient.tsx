"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { openOceanTheme } from "@openocean.finance/widget";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useWalletConnection } from "@/hooks/useWalletConnection";

const OPENOCEAN_REFERRER_ADDRESS =
  process.env.NEXT_PUBLIC_OPENOCEAN_REFERRER_ADDRESS ||
  "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573";

const WIDGET_BASE_CONFIG = {
  variant: "compact",
  subvariant: "default",
  slippage: 0.03,
  defaultChain: 8453,
  defaultFromToken: "0x0000000000000000000000000000000000000000",
  defaultToToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
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

  const config = useMemo(
    () => ({
      ...WIDGET_BASE_CONFIG,
      // Use OpenOcean's official mode setting, with its bundled dark palette to avoid a light-card flash.
      appearance: resolvedTheme,
      theme: resolvedTheme === "dark" ? openOceanTheme : undefined,
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
