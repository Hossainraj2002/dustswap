import type { WidgetConfig } from "@lifi/widget";
import {
  DEFAULT_SOURCE_CHAIN_ID,
  getLifiRpcUrls,
  SUPPORTED_EVM_CHAIN_IDS,
} from "@/config/web3";

// Export integrator name
export const LIFI_INTEGRATOR =
  process.env.NEXT_PUBLIC_LIFI_INTEGRATOR || "DustSwap";

const configuredFee = Number(process.env.NEXT_PUBLIC_LIFI_FEE);
const lifiRpcUrls = getLifiRpcUrls();

export const widgetConfig: WidgetConfig = {
  integrator: LIFI_INTEGRATOR,
  ...(Number.isFinite(configuredFee) &&
  configuredFee > 0 &&
  configuredFee < 1
    ? { fee: configuredFee }
    : {}),

  appearance: "dark",
  theme: {
    container: {
      border: "1px solid rgba(255, 255, 255, 0.08)",
      borderRadius: "16px",
      boxShadow: "0 24px 80px rgba(0, 0, 0, 0.28)",
      backgroundColor: "#0b1020",
    },
    colorSchemes: {
      dark: {
        palette: {
          primary: {
            main: "#3b82f6",
            dark: "#2563eb",
            light: "#60a5fa",
          },
          secondary: {
            main: "#14b8a6",
          },
          background: {
            default: "#050816",
            paper: "#0b1020",
          },
        },
      },
    },
    typography: {
      fontFamily: "'Inter', sans-serif",
    },
  },

  // Default source on Base, but let users pick any supported destination.
  fromChain: DEFAULT_SOURCE_CHAIN_ID,
  chains: {
    allow: [...SUPPORTED_EVM_CHAIN_IDS],
  },
  ...(lifiRpcUrls ? { sdkConfig: { rpcUrls: lifiRpcUrls } } : {}),

  buildUrl: true,
  useRecommendedRoute: true,
  variant: "wide",
  subvariant: "default",
};
