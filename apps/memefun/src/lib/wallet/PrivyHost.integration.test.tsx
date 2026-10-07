/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WalletProvider, useWallet } from "./WalletProvider";

const sdk = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "sdk-reconnect-regression";
  return { renders: 0, statuses: [] as string[] };
});
vi.mock("next/dynamic", async () => {
  const { default: Host } = await import("./PrivyHost");
  return { default: () => Host };
});
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ preview: false }) }));
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => {
    if (++sdk.renders > 30) throw new Error("SDK wallet synchronization repeatedly reconnected without user action");
    return children;
  },
  useWallets: () => ({ wallets: [], ready: true }), // Deliberately fresh array each SDK render.
  usePrivy: () => ({ ready: true, user: null }),
  useConnectWallet: () => ({ connectWallet: vi.fn() }),
  useConnectOrCreateWallet: () => ({ connectOrCreateWallet: vi.fn() }),
  useLogin: () => ({ login: vi.fn() }),
}));
vi.mock("./useWalletConnection", () => ({
  PRIVY_WALLET_LIST: ["metamask"],
  WalletConnectionProvider: ({ children }: { children: ReactNode }) => children,
  useWalletConnection: () => ({ openWalletModal: vi.fn(), disconnectWallet: vi.fn(), isConnecting: false }),
}));
vi.mock("./useBaseChainSwitch", () => ({ useBaseChainSwitch: () => ({ isOnBase: false, isSwitching: false, switchToBase: vi.fn() }) }));
vi.mock("./ethereumProviders", () => ({ ensureOkxEip6963Shim: vi.fn() }));
// The installed wagmi AND @privy-io/wagmi providers/actions are real in this test.
vi.mock("./wagmi", async () => {
  const { createConfig, http } = await import("wagmi");
  const { base } = await import("wagmi/chains");
  return { MEMEFUN_CHAINS: [base], wagmiConfig: createConfig({ chains: [base], transports: { [base.id]: http() }, ssr: false, storage: null, multiInjectedProviderDiscovery: false }) };
});

function Status() {
  const wallet = useWallet();
  sdk.statuses.push(wallet.status);
  return <span>{wallet.status}</span>;
}
const page = (client: QueryClient) => <QueryClientProvider client={client}><WalletProvider><Status /></WalletProvider></QueryClientProvider>;
beforeEach(() => { sdk.renders = 0; sdk.statuses = []; });
afterEach(cleanup);

it("does not restart native connection state when Privy wallet-array identities change", async () => {
  const client = new QueryClient();
  const mounted = render(page(client));
  for (let index = 0; index < 12; index++) {
    await act(async () => { mounted.rerender(page(client)); await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  expect(sdk.statuses).not.toContain("connecting");
  expect(sdk.renders).toBeLessThan(20);
  expect(mounted.getByText("disconnected")).toBeTruthy();
  client.clear();
});
