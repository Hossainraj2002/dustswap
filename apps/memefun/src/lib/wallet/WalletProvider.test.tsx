/** @vitest-environment jsdom */
import { StrictMode, type ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MemefunWallet } from "./walletState";
import { WalletProvider, useWallet } from "./WalletProvider";
import { consumePendingConnect, requestConnectWhenReady } from "./walletState";

const view = vi.hoisted(() => {
  const previousAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "wallet-provider-regression";
  return {
    previousAppId,
    account: { address: undefined as `0x${string}` | undefined, status: "disconnected" as "disconnected" | "connecting" | "reconnecting" | "connected", chainId: undefined as number | undefined },
    onBase: false,
    switching: false,
    theme: "dark" as "dark" | "light",
    connect: vi.fn<(...args: unknown[]) => Promise<void>>(),
    disconnect: vi.fn<() => Promise<void>>(),
    switchChain: vi.fn<() => Promise<boolean>>(),
    wallet: null as MemefunWallet | null,
    configs: [] as { appearance: { theme: string } }[],
    renders: 0,
  };
});

// Mount the real lazy host synchronously so the state feedback path is exercised.
vi.mock("next/dynamic", async () => {
  const { default: PrivyHost } = await import("./PrivyHost");
  return { default: () => PrivyHost };
});
vi.mock("@/lib/preview/scenario", () => ({ usePreview: () => ({ preview: false }) }));
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ resolvedTheme: view.theme }) }));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children, config }: { children: ReactNode; config: { appearance: { theme: string } } }) => {
    // Bound a regression so a broken feedback loop fails quickly and clearly.
    if (++view.renders > 40) throw new Error("Wallet host repeatedly updated its parent without a wallet change");
    view.configs.push(config);
    return children;
  },
}));
vi.mock("@privy-io/wagmi", () => ({ WagmiProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("wagmi", () => ({ useAccount: () => ({ ...view.account }) }));
vi.mock("./wagmi", () => ({ MEMEFUN_CHAINS: [{ id: 84532 }], wagmiConfig: {} }));
vi.mock("./ethereumProviders", () => ({ ensureOkxEip6963Shim: vi.fn() }));
vi.mock("./useWalletConnection", () => ({
  PRIVY_WALLET_LIST: ["metamask"],
  WalletConnectionProvider: ({ children }: { children: ReactNode }) => children,
  useWalletConnection: () => {
    const { connect, disconnect } = view;
    // The SDK is allowed to replace its context and callbacks on every render.
    return { openWalletModal: (...args: unknown[]) => connect(...args), disconnectWallet: () => disconnect() };
  },
}));
vi.mock("./useBaseChainSwitch", () => ({
  useBaseChainSwitch: () => {
    const { switchChain } = view;
    return { isOnBase: view.onBase, isSwitching: view.switching, switchToBase: () => switchChain() };
  },
}));

function Probe() {
  view.wallet = useWallet();
  return <span>{view.wallet.status}</span>;
}

const page = () => <WalletProvider><Probe /></WalletProvider>;
const wallet = () => {
  expect(view.wallet).not.toBeNull();
  return view.wallet!;
};

beforeEach(() => {
  view.account = { address: undefined, status: "disconnected", chainId: undefined };
  view.onBase = false;
  view.switching = false;
  view.theme = "dark";
  view.connect = vi.fn().mockResolvedValue(undefined);
  view.disconnect = vi.fn().mockResolvedValue(undefined);
  view.switchChain = vi.fn().mockResolvedValue(true);
  view.wallet = null;
  view.configs = [];
  view.renders = 0;
  consumePendingConnect();
});
afterEach(cleanup);
afterAll(() => {
  if (view.previousAppId === undefined) delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  else process.env.NEXT_PUBLIC_PRIVY_APP_ID = view.previousAppId;
});

describe("real wallet host updates", () => {
  it("settles despite unstable SDK callbacks and uses their latest implementations", async () => {
    const mounted = render(page());
    const initial = wallet();
    expect(initial).toMatchObject({ mode: "privy", status: "disconnected", address: null, chainId: null, onBase: false });
    expect(view.renders).toBeLessThan(4);
    const previous = { connect: view.connect, disconnect: view.disconnect, switchChain: view.switchChain };
    view.connect = vi.fn().mockResolvedValue(undefined);
    view.disconnect = vi.fn().mockResolvedValue(undefined);
    view.switchChain = vi.fn().mockResolvedValue(true);
    mounted.rerender(page());
    expect(wallet()).toBe(initial);
    expect(new Set(view.configs).size).toBe(1);
    await initial.connect();
    await initial.disconnect();
    await initial.switchToBase();
    expect(view.connect).toHaveBeenCalledWith("Connect a wallet to trade and launch on memefun.");
    expect(view.disconnect).toHaveBeenCalledOnce();
    expect(view.switchChain).toHaveBeenCalledOnce();
    for (const action of Object.values(previous)) expect(action).not.toHaveBeenCalled();
    view.theme = "light";
    mounted.rerender(page());
    expect(wallet()).toBe(initial);
    expect(view.configs.at(-1)?.appearance.theme).toBe("light");
    expect(new Set(view.configs).size).toBe(2);
  });

  it("reports account, connection, network and pending switch changes with stable actions", () => {
    const mounted = render(page());
    const initial = wallet();
    view.account.status = "reconnecting";
    mounted.rerender(page());
    expect(wallet().status).toBe("connecting");
    view.account = { address: "0x0000000000000000000000000000000000000001", status: "connected", chainId: 84532 };
    view.onBase = true;
    mounted.rerender(page());
    expect(wallet()).toMatchObject({ status: "connected", address: view.account.address, chainId: 84532, onBase: true });
    view.account.address = "0x0000000000000000000000000000000000000002";
    view.account.chainId = 1;
    view.onBase = false;
    view.switching = true;
    mounted.rerender(page());
    expect(wallet()).toMatchObject({ address: view.account.address, chainId: 1, onBase: false, isSwitching: true });
    view.account = { address: undefined, status: "disconnected", chainId: undefined };
    view.switching = false;
    mounted.rerender(page());
    expect(wallet()).toMatchObject({ status: "disconnected", address: null, chainId: null, onBase: false, isSwitching: false });
    expect(wallet().connect).toBe(initial.connect);
    expect(wallet().disconnect).toBe(initial.disconnect);
    expect(wallet().switchToBase).toBe(initial.switchToBase);
    expect(view.renders).toBeLessThan(12);
  });

  it("replays a connect requested before host loading exactly once in Strict Mode", () => {
    requestConnectWhenReady();
    const mounted = render(<StrictMode>{page()}</StrictMode>);
    expect(view.connect).toHaveBeenCalledOnce();
    mounted.rerender(<StrictMode>{page()}</StrictMode>);
    expect(view.connect).toHaveBeenCalledOnce();
    expect(view.renders).toBeLessThan(8);
  });
});
