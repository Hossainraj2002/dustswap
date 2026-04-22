"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { WidgetSkeleton } from "@openocean.finance/widget/dist/esm/components/Skeleton/WidgetSkeleton.js";
import { useWalletConnection } from "@/hooks/useWalletConnection";

const OPENOCEAN_REFERRER_ADDRESS =
  process.env.NEXT_PUBLIC_OPENOCEAN_REFERRER_ADDRESS ||
  "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573";

const WIDGET_BASE_CONFIG = {
  variant: "compact",
  subvariant: "default",
  appearance: "light",
  slippage: 0.005,
  theme: {
    palette: {
      primary: { main: "#006Eff" },
      secondary: { main: "#FFC800" },
      background: { default: "#ffffff", paper: "#f8f8fa" },
      text: { primary: "#00070F", secondary: "#6A7481" },
      grey: {
        200: "#e6e6e6",
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
    typography: { fontFamily: "Inter, sans-serif" },
    container: {
      boxShadow: "0px 8px 32px rgba(0, 0, 0, 0.08)",
      borderRadius: "16px",
    },
    components: {
      MuiCard: { defaultProps: { variant: "filled" } },
      MuiTabs: {
        styleOverrides: {
          root: {
            backgroundColor: "#f8f8fa",
            ".MuiTabs-indicator": { backgroundColor: "#ffffff" },
          },
        },
      },
    },
  },
  defaultChain: 8453,
  defaultFromToken: "0x0000000000000000000000000000000000000000",
  defaultToToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
} as const;

const OpenOceanWidget = dynamic<{ integrator: string; config: any }>(
  () => import("@openocean.finance/widget").then((mod) => mod.OpenOceanWidget as any),
  {
    ssr: false,
    loading: () => <WidgetSkeleton config={WIDGET_BASE_CONFIG as any} />,
  }
);

export default function SwapPageClient() {
  const { openWalletModal } = useWalletConnection();

  const config = useMemo(
    () => ({
      ...WIDGET_BASE_CONFIG,
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
    [openWalletModal]
  );

  return (
    <main
      className="flex flex-col items-center justify-center overflow-x-hidden bg-transparent px-0 py-6 sm:px-4 sm:py-8"
      style={{ minHeight: "calc(100dvh - 100px)" }}
    >
      <div className="mx-auto flex w-full max-w-[420px] justify-center">
        <div className="dustswap-openocean-widget w-full min-w-0">
          <OpenOceanWidget integrator="DustSwap" config={config as any} />
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
