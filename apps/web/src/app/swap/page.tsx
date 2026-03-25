"use client";

import dynamic from 'next/dynamic';
import { useAppKit } from '@reown/appkit/react';
import { useMemo } from 'react';

const OpenOceanWidget = dynamic<{ integrator: string; config: any }>(
  () => import('@openocean.finance/widget').then((mod) => mod.OpenOceanWidget as any),
  { ssr: false }
);

export default function SwapPage() {
  const { open } = useAppKit();

  const config = useMemo(() => ({
    variant: "compact",
    subvariant: "default",
    appearance: "light",
    referrer: {
      address: "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573",
      fee: ".25"
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
          800: "#373F48"
        }
      },
      shape: {
        borderRadius: 12,
        borderRadiusSecondary: 12,
        borderRadiusTertiary: 24
      },
      typography: { fontFamily: "Courier New, Courier, monospace" },
      container: {
        boxShadow: "0px 8px 32px rgba(0, 0, 0, 0.08)",
        borderRadius: "16px"
      },
      components: {
        MuiCard: { defaultProps: { variant: "filled" } },
        MuiTabs: {
          styleOverrides: {
            root: {
              backgroundColor: "#f8f8fa",
              ".MuiTabs-indicator": { backgroundColor: "#ffffff" }
            }
          }
        }
      }
    },
    walletConfig: {
      onConnect: () => {
        open();
      }
    },
    chains: {
      allow: [
        1, 56, 1151111081099710, 42161, 10, 324, 137, 43114, 250, 146,
        80094, 8453, 59144, 534352, 81457, 34443, 5000, 130, 999, 14,
        1923, 169, 1101, 40, 100, 30, 2222, 1329, 1088, 204, 42220,
        1625, 33139, 25, 1313161554, 1285, 1666600000, 10143, 999,
        9745, 98866, 239, 143, 20000000000001, 14, 20000000000006
      ]
    },
    defaultChain: 8453,
    defaultFromToken: "0x0000000000000000000000000000000000000000S",
    defaultToToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  }), [open]);

  return (
    <main className="min-h-screen bg-transparent px-4 py-8 flex flex-col items-center justify-center">
      <div className="w-full max-w-lg mx-auto">
        <OpenOceanWidget integrator="DustSwap" config={config as any} />
      </div>
    </main>
  );
}
