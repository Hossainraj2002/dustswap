import type { WidgetConfig } from "@lifi/widget";
import type { WalletMenuOpenArgs } from "@lifi/wallet-management";
import { DEFAULT_SOURCE_CHAIN_ID, getLifiRpcUrls } from "@/config/web3";
import { lifiEvmProvider } from "@/lib/lifi";

// Export integrator name
export const LIFI_INTEGRATOR =
  process.env.NEXT_PUBLIC_LIFI_INTEGRATOR || "DustSwap";

const configuredFee = Number(process.env.NEXT_PUBLIC_LIFI_FEE);
const lifiRpcUrls = getLifiRpcUrls();
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID;

type CreateWidgetConfigOptions = {
  onConnect?: (args?: WalletMenuOpenArgs) => void;
};

const baseWidgetConfig: WidgetConfig = {
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

  fromChain: DEFAULT_SOURCE_CHAIN_ID,

  sdkConfig: {
    ...(lifiRpcUrls ? { rpcUrls: lifiRpcUrls } : {}),
    providers: [lifiEvmProvider],
    executionOptions: {
      // Coinbase Smart Wallet may fall back to classic approvals more reliably
      // than permit-based message signing depending on account capabilities.
      disableMessageSigning: true,
    },
  },

  // Avoid stale URL/query-state breaking route lookups across refreshes.
  buildUrl: false,
  keyPrefix: "dustswap-lifi-v2",
  useRecommendedRoute: false,
  variant: "wide",
  subvariant: "split",
};

export function createWidgetConfig({
  onConnect,
}: CreateWidgetConfigOptions = {}): WidgetConfig {
  return {
    ...baseWidgetConfig,
    walletConfig: onConnect
      ? {
          onConnect,
          ...(walletConnectProjectId
            ? {
                walletConnect: {
                  projectId: walletConnectProjectId,
                },
              }
            : {}),
          coinbase: {
            appName: "DustSwap",
            appLogoUrl: "https://dustswap.xyz/logo.png",
          },
          usePartialWalletManagement: true,
        }
      : undefined,
  };
}
