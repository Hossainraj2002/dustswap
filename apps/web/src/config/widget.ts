import type { WidgetConfig } from "@lifi/widget";

// Export integrator name
export const LIFI_INTEGRATOR =
  process.env.NEXT_PUBLIC_LIFI_INTEGRATOR || "DustSwap";

export const widgetConfig: WidgetConfig = {
  integrator: LIFI_INTEGRATOR,
  apiKey: process.env.NEXT_PUBLIC_LIFI_API_KEY && process.env.NEXT_PUBLIC_LIFI_API_KEY !== "PLACEHOLDER_FOR_API_KEY" 
    ? process.env.NEXT_PUBLIC_LIFI_API_KEY 
    : undefined,
  // Fee configuration: 0.2% = 20 basis points
  fee: 0.002, // 0.2%

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

  // Chain configuration
  fromChain: 8453, // Base
  toChain: 8453,   // Base
  chains: {
    allow: [1, 10, 56, 137, 42161, 43114, 8453], // Ethereum, Optimism, BSC, Polygon, Arbitrum, Avalanche, Base
  },

  // Widget appearance
  variant: "wide", // Options: "compact" | "wide" | "drawer"
  subvariant: "default", // Options: "default" | "swap" | "split"
};
