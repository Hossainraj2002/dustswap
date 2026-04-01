"use client";

import dynamic from "next/dynamic";
import { useAppKit } from "@reown/appkit/react";
import { useMemo } from "react";

const OPENOCEAN_REFERRER_ADDRESS =
  process.env.NEXT_PUBLIC_OPENOCEAN_REFERRER_ADDRESS ||
  "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573";

const OpenOceanWidget = dynamic<{ integrator: string; config: any }>(
  () => import("@openocean.finance/widget").then((mod) => mod.OpenOceanWidget as any),
  { ssr: false }
);

export default function SwapPageClient() {
  const { open } = useAppKit();

  const config = useMemo(
    () => ({
      variant: "compact",
      subvariant: "default",
      appearance: "light",
      referrer: {
        address: OPENOCEAN_REFERRER_ADDRESS,
        fee: ".25",
      },
      slippage: 0.005,
      theme: {
        palette: {
          primary: { main: "#006Eff" },
          secondary: { main: "#FFC800" },
          background: { default: "#ffffff", paper: "#f8f8fa" },
          text: { primary: "#00070F", secondary: "#6A7481" },
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
        typography: { fontFamily: "Courier New, Courier, monospace" },
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
      walletConfig: {
        onConnect: () => {
          open();
        },
      },
      chains: {
        allow: [
          1, 56, 1151111081099710, 42161, 10, 324, 137, 43114, 250, 146, 80094, 8453,
          59144, 534352, 81457, 34443, 5000, 130, 999, 14, 1923, 169, 1101, 40, 100,
          30, 2222, 1329, 1088, 204, 42220, 1625, 33139, 25, 1313161554, 1285,
          1666600000, 10143, 999, 9745, 98866, 239, 143, 20000000000001, 14,
          20000000000006,
        ],
      },
      defaultChain: 8453,
      defaultFromToken: "0x0000000000000000000000000000000000000000",
      defaultToToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    }),
    [open]
  );

  return (
    <main className="flex min-h-[calc(100vh-100px)] flex-col items-center justify-center bg-transparent px-0 sm:px-4 py-6 sm:py-8 overflow-x-hidden">
      <div className="swap-widget-stage w-full max-w-[760px]">
        <div className="swap-widget-stage__paper" aria-hidden="true" />
        <div className="swap-widget-stage__halo swap-widget-stage__halo--left" aria-hidden="true" />
        <div className="swap-widget-stage__halo swap-widget-stage__halo--right" aria-hidden="true" />
        <div className="mx-auto flex w-full max-w-[420px] justify-center">
          <div className="dustswap-openocean-widget relative z-[1] w-full min-w-0">
            <OpenOceanWidget integrator="DustSwap" config={config as any} />
          </div>
        </div>
      </div>
      <style jsx global>{`
        .swap-widget-stage {
          position: relative;
          padding: 28px;
          border-radius: 36px;
          isolation: isolate;
        }

        .swap-widget-stage__paper {
          position: absolute;
          inset: 0;
          border-radius: inherit;
          border: 1px solid rgba(15, 23, 42, 0.08);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(244, 247, 252, 0.92)),
            repeating-linear-gradient(
              0deg,
              transparent 0,
              transparent 18px,
              rgba(15, 23, 42, 0.055) 18px,
              rgba(15, 23, 42, 0.055) 19px
            ),
            repeating-linear-gradient(
              90deg,
              transparent 0,
              transparent 18px,
              rgba(15, 23, 42, 0.055) 18px,
              rgba(15, 23, 42, 0.055) 19px
            ),
            repeating-linear-gradient(
              0deg,
              transparent 0,
              transparent 72px,
              rgba(31, 41, 55, 0.085) 72px,
              rgba(31, 41, 55, 0.085) 73px
            ),
            repeating-linear-gradient(
              90deg,
              transparent 0,
              transparent 72px,
              rgba(31, 41, 55, 0.085) 72px,
              rgba(31, 41, 55, 0.085) 73px
            );
          box-shadow:
            0 30px 80px rgba(148, 163, 184, 0.16),
            inset 0 1px 0 rgba(255, 255, 255, 0.78),
            inset 0 0 0 1px rgba(255, 255, 255, 0.42);
          overflow: hidden;
        }

        .swap-widget-stage__paper::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background:
            radial-gradient(circle at 16% 14%, rgba(255, 255, 255, 0.92), transparent 34%),
            radial-gradient(circle at 84% 86%, rgba(191, 219, 254, 0.18), transparent 30%);
          mix-blend-mode: screen;
          pointer-events: none;
        }

        .swap-widget-stage__paper::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.54), transparent 22%, transparent 78%, rgba(226, 232, 240, 0.4)),
            linear-gradient(90deg, rgba(248, 250, 252, 0.9), transparent 12%, transparent 88%, rgba(248, 250, 252, 0.9));
          mask-image: radial-gradient(circle at center, black 62%, transparent 100%);
          pointer-events: none;
        }

        .swap-widget-stage__halo {
          position: absolute;
          width: 220px;
          height: 220px;
          border-radius: 999px;
          filter: blur(36px);
          opacity: 0.55;
          z-index: 0;
          pointer-events: none;
        }

        .swap-widget-stage__halo--left {
          top: -18px;
          left: 16px;
          background: radial-gradient(circle, rgba(148, 163, 184, 0.26), transparent 70%);
        }

        .swap-widget-stage__halo--right {
          right: 8px;
          bottom: -30px;
          background: radial-gradient(circle, rgba(96, 165, 250, 0.16), transparent 72%);
        }

        .dustswap-openocean-widget {
          position: relative;
          z-index: 1;
        }

        @media (max-width: 420px) {
          .swap-widget-stage {
            padding: 16px 10px 18px;
            border-radius: 28px;
          }

          .dustswap-openocean-widget,
          .dustswap-openocean-widget > .MuiBox-root,
          .dustswap-openocean-widget > .MuiBox-root > .MuiBox-root {
            width: 100%;
            max-width: 100% !important;
          }

          .dustswap-openocean-widget > .MuiBox-root > .MuiBox-root {
            min-width: 0 !important;
          }

          .dustswap-openocean-widget .MuiContainer-root {
            padding-left: 12px;
            padding-right: 12px;
          }

          .dustswap-openocean-widget .MuiCardContent-root > .MuiBox-root {
            align-items: flex-start;
            gap: 8px;
          }

          .dustswap-openocean-widget .MuiCardContent-root > .MuiBox-root > .MuiBox-root:first-child {
            flex: 0.85 1 0%;
            min-width: 0;
          }

          .dustswap-openocean-widget .MuiCardContent-root > .MuiBox-root > .MuiBox-root:last-child {
            flex: 1.15 1 0%;
            min-width: 0;
          }

          .dustswap-openocean-widget .MuiCardHeader-root {
            width: 100% !important;
            min-width: 0;
            padding: 12px 8px 12px 12px;
          }

          .dustswap-openocean-widget .MuiCardHeader-content {
            min-width: 0;
          }

          .dustswap-openocean-widget .MuiCardHeader-content .MuiTypography-root {
            min-width: 0;
          }

          .dustswap-openocean-widget .MuiCardContent-root > .MuiBox-root > .MuiBox-root:last-child > .MuiBox-root {
            width: 100%;
            padding: 12px 12px 8px 4px;
          }

          .dustswap-openocean-widget .MuiFormControl-root,
          .dustswap-openocean-widget .MuiInputBase-root {
            width: 100%;
            min-width: 0;
          }

          .dustswap-openocean-widget .MuiInputBase-input {
            min-width: 0 !important;
            font-size: 18px !important;
            line-height: 1.2 !important;
            padding-left: 0 !important;
          }

          .dustswap-openocean-widget .MuiInputAdornment-positionEnd {
            margin-left: 6px;
            align-self: flex-start;
          }

          .dustswap-openocean-widget .MuiButton-root {
            padding: 4px 8px;
            font-size: 12px;
          }

          .dustswap-openocean-widget .MuiFormHelperText-root {
            flex-wrap: wrap;
            justify-content: space-between;
            row-gap: 2px;
            margin-left: 0;
            white-space: normal !important;
          }

          .dustswap-openocean-widget .MuiFormHelperText-root .MuiTypography-root {
            min-width: 0;
            font-size: 11px;
            line-height: 1.2;
          }
        }
      `}</style>
    </main>
  );
}
