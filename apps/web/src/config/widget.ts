import type { WidgetConfig } from "@lifi/widget";

// Export integrator name
export const LIFI_INTEGRATOR =
  process.env.NEXT_PUBLIC_LIFI_INTEGRATOR || "DustSwap";

export const widgetConfig: WidgetConfig = {
  integrator: LIFI_INTEGRATOR,
  // Fee configuration: 0.2% = 20 basis points
  fee: 0.002,

  // Theme customization
  theme: {
    container: {
      border: "1px solid rgb(234, 234, 234)",
      borderRadius: "16px",
      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
    },
    palette: {
      primary: {
        main: "#3b82f6",
        dark: "#2563eb",
        light: "#60a5fa",
      },
      secondary: {
        main: "#8b5cf6",
      },
      background: {
        default: "#ffffff",
        paper: "#f9fafb",
      },
    },
    typography: {
      fontFamily: "'Inter', sans-serif",
    },
  },

  // Chain configuration - Base as primary
  chains: {
    allow: [8453, 1, 42161, 137, 56, 10, 43114], // Base, ETH, Arb, Polygon, BSC, Optimism, Avalanche
  },

  // Widget appearance
  variant: "wide", // Options: "compact" | "wide" | "drawer"
  subvariant: "default", // Options: "default" | "swap" | "split"
};
