/** @vitest-environment jsdom */
import type { ConnectedWallet } from "@privy-io/react-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfig, createStorage, http } from "wagmi";
import { disconnect, getAccount, getWalletClient } from "wagmi/actions";
import { baseSepolia } from "wagmi/chains";
import type { Address, Hex } from "viem";
import { activatePrivyWallet } from "./activateWallet";
import { withBuilderAttribution } from "./attributedWallet";
import { DATA_SUFFIX } from "./builderCode";

const ALICE = "0x0000000000000000000000000000000000000001" as const;
const BOB = "0x0000000000000000000000000000000000000002" as const;
const TOKEN = "0x0000000000000000000000000000000000000003" as const;
const HASH = `0x${"12".repeat(32)}` as Hex;
type RpcCall = { method: string; params?: unknown };
type Listener = (...args: unknown[]) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function provider(accounts: readonly Address[] = [ALICE]) {
  const listeners = new Map<string, Set<Listener>>();
  const request = vi.fn(async ({ method }: RpcCall): Promise<unknown> => {
    if (method === "eth_accounts") return [...accounts];
    if (method === "eth_chainId") return "0x14a34";
    if (method === "eth_sendTransaction") return HASH;
    if (method === "wallet_sendCalls") return { id: "selected-wallet-batch" };
    if (method === "wallet_revokePermissions") return null;
    throw new Error(`Unexpected provider request: ${method}`);
  });
  return {
    request,
    on: vi.fn((event: string, listener: Listener) => {
      const handlers = listeners.get(event) ?? new Set<Listener>();
      handlers.add(listener);
      listeners.set(event, handlers);
    }),
    removeListener: vi.fn((event: string, listener: Listener) => listeners.get(event)?.delete(listener)),
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    listenerCount() { return [...listeners.values()].reduce((count, handlers) => count + handlers.size, 0); },
  };
}

function wallet(selectedProvider: ReturnType<typeof provider>, address: Address = ALICE, id = "selected-wallet") {
  return {
    address,
    type: "ethereum",
    meta: { id, name: id },
    getEthereumProvider: vi.fn(async () => selectedProvider),
  } as unknown as ConnectedWallet;
}

function configuration(storage: ReturnType<typeof createStorage> | null = null) {
  return createConfig({
    chains: [baseSepolia],
    transports: { [baseSepolia.id]: http() },
    storage,
    ssr: false,
    multiInjectedProviderDiscovery: false,
  });
}

async function flush() {
  for (let index = 0; index < 25; index++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  delete (window as Window & { ethereum?: unknown }).ethereum;
});

describe("native selected Privy wallet activation", () => {
  it("replaces a connected provider rather than retaining a hidden second connection", async () => {
    const first = provider(), second = provider();
    const config = configuration();
    let selectedId = "first";
    await activatePrivyWallet(config, wallet(first, ALICE, "first"), () => selectedId === "first");
    selectedId = "second";
    await activatePrivyWallet(config, wallet(second, ALICE, "second"), () => selectedId === "second");
    expect(config.state.connections.size).toBe(1);
    expect(getAccount(config).connector?.id).toContain("memefun.second.");
    selectedId = "disconnected";
    await disconnect(config);
    expect(getAccount(config).status).toBe("disconnected");
    expect(first.listenerCount()).toBe(0);
  });
  it("uses only the selected provider/account and preserves attribution on transactions and batches", async () => {
    const unrelated = provider([ALICE]);
    Object.defineProperty(window, "ethereum", { configurable: true, value: unrelated });
    const selected = provider([BOB, ALICE]);
    const config = configuration();
    await activatePrivyWallet(config, wallet(selected), () => true);

    expect(getAccount(config)).toMatchObject({ status: "connected", address: ALICE, addresses: [ALICE], chainId: baseSepolia.id });
    expect(config.state.connections.size).toBe(1);
    expect(unrelated.request).not.toHaveBeenCalled();
    const connectedClient = await getWalletClient(config);
    const attributedClient = withBuilderAttribution(connectedClient);
    await attributedClient.sendTransaction({ account: connectedClient.account, chain: baseSepolia, to: TOKEN, value: 1n });
    await attributedClient.sendCalls({ account: connectedClient.account, chain: baseSepolia, calls: [{ to: TOKEN, data: "0x1234" }] });

    const transaction = selected.request.mock.calls.find(([call]) => call.method === "eth_sendTransaction")![0];
    expect(transaction.params).toEqual([expect.objectContaining({ from: ALICE, to: TOKEN, data: DATA_SUFFIX })]);
    const batch = selected.request.mock.calls.find(([call]) => call.method === "wallet_sendCalls")![0];
    expect(batch.params).toEqual([expect.objectContaining({ from: ALICE, capabilities: expect.objectContaining({ dataSuffix: { value: DATA_SUFFIX } }) })]);
    expect(selected.request.mock.calls.map(([call]) => call.method)).not.toContain("eth_requestAccounts");
    expect(selected.request.mock.calls.map(([call]) => call.method)).not.toContain("wallet_requestPermissions");
    expect(unrelated.request).not.toHaveBeenCalled();
  });

  it("refuses an unavailable selected account instead of choosing the provider's first account", async () => {
    const selected = provider([BOB]);
    const config = configuration();
    await expect(activatePrivyWallet(config, wallet(selected), () => true)).rejects.toThrow("selected wallet account is unavailable");
    expect(getAccount(config).status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
    expect(selected.listenerCount()).toBe(0);
  });

  it("coalesces queued activations of the same provider and account into one native connection", async () => {
    const selected = provider();
    const config = configuration();
    const selectedWallet = wallet(selected);
    await Promise.all([
      activatePrivyWallet(config, selectedWallet, () => true),
      activatePrivyWallet(config, selectedWallet, () => true),
    ]);
    expect(config.state.connections.size).toBe(1);
    await disconnect(config);
    expect(getAccount(config).status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
  });

  it("disconnects when the selected account disappears without switching to another exposed account", async () => {
    const selected = provider([BOB, ALICE]);
    const config = configuration();
    await activatePrivyWallet(config, wallet(selected), () => true);
    selected.emit("accountsChanged", [BOB, ALICE]);
    await flush();
    expect(getAccount(config).address).toBe(ALICE);
    selected.emit("accountsChanged", [BOB]);
    await flush();
    expect(getAccount(config).status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
  });

  it("rejects an invalid chain without leaving a native connection behind", async () => {
    const selected = provider();
    const originalRequest = selected.request.getMockImplementation()!;
    selected.request.mockImplementation(call => call.method === "eth_chainId" ? Promise.resolve("not-a-chain") : originalRequest(call));
    const config = configuration();
    await expect(activatePrivyWallet(config, wallet(selected), () => true)).rejects.toThrow("invalid network");
    expect(getAccount(config).status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
    expect(selected.listenerCount()).toBe(0);
  });

  it("cancels delayed provider initialization before native connection or permission requests", async () => {
    const initialization = deferred<ReturnType<typeof provider>>();
    const selected = provider();
    const selectedWallet = wallet(selected);
    selectedWallet.getEthereumProvider = vi.fn(() => initialization.promise) as ConnectedWallet["getEthereumProvider"];
    const config = configuration();
    let current = true;
    const activation = activatePrivyWallet(config, selectedWallet, () => current);
    current = false;
    initialization.resolve(selected);
    await expect(activation).rejects.toThrow("cancelled");
    expect(config.state.connections.size).toBe(0);
    expect(getAccount(config).status).toBe("disconnected");
    expect(selected.request).not.toHaveBeenCalled();
  });

  it("times out a stalled chain read and discards its late completion", async () => {
    const chain = deferred<unknown>();
    const selected = provider();
    const originalRequest = selected.request.getMockImplementation()!;
    selected.request.mockImplementation(call => call.method === "eth_chainId" ? chain.promise : originalRequest(call));
    const config = configuration();
    const failure = activatePrivyWallet(config, wallet(selected), () => true, 50).catch(error => error);
    await flush();
    expect(config.state.status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(51);
    expect(await failure).toMatchObject({ message: expect.stringContaining("did not finish connecting") });
    expect(getAccount(config).status).toBe("disconnected");
    chain.resolve("0x14a34");
    await flush();
    expect(getAccount(config).status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
    expect(selected.listenerCount()).toBe(0);
  });

  it("serializes a newer selection past a timed-out native storage write and disconnects fully", async () => {
    const lateWrite = deferred<void>();
    const storage = createStorage({ storage: {
      getItem: () => null,
      removeItem: () => {},
      setItem: (key, value) => key.endsWith("recentConnectorId") && value.includes("old-provider") ? lateWrite.promise : undefined,
    } });
    const oldProvider = provider([ALICE]);
    const newProvider = provider([BOB]);
    const config = configuration(storage);
    let selection = "old-provider";
    const oldFailure = activatePrivyWallet(config, wallet(oldProvider, ALICE, "old-provider"), () => selection === "old-provider", 50).catch(error => error);
    await flush();
    expect(config.state.status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(51);
    expect(await oldFailure).toBeInstanceOf(Error);
    selection = "new-provider";
    const newerActivation = activatePrivyWallet(config, wallet(newProvider, BOB, "new-provider"), () => selection === "new-provider", 1_000);
    await flush();
    expect(newProvider.request.mock.calls.some(([call]) => call.method === "eth_chainId")).toBe(false);
    lateWrite.resolve();
    await newerActivation;
    expect(getAccount(config)).toMatchObject({ status: "connected", address: BOB });
    expect(config.state.connections.size).toBe(1);
    expect(oldProvider.listenerCount()).toBe(0);
    selection = "disconnected";
    await disconnect(config);
    oldProvider.emit("accountsChanged", [ALICE]);
    newProvider.emit("accountsChanged", [BOB]);
    await flush();
    expect(getAccount(config).status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
  });

  it("allows a healthy wallet after the previous provider never finishes its chain request", async () => {
    const stalled = provider();
    const originalRequest = stalled.request.getMockImplementation()!;
    stalled.request.mockImplementation(call => call.method === "eth_chainId" ? new Promise(() => {}) : originalRequest(call));
    const healthy = provider([BOB]);
    const config = configuration();
    const failure = activatePrivyWallet(config, wallet(stalled, ALICE, "stalled-provider"), () => true, 50).catch(error => error);
    await flush();
    await vi.advanceTimersByTimeAsync(51);
    expect(await failure).toBeInstanceOf(Error);

    const next = activatePrivyWallet(config, wallet(healthy, BOB, "healthy-provider"), () => true, 1_000);
    await flush();
    expect(getAccount(config)).toMatchObject({ status: "connected", address: BOB });
    await next;
    expect(config.state.connections.size).toBe(1);
    expect(stalled.listenerCount()).toBe(0);
  });

  it("blocks a stale wallet client and provider events after manual disconnect", async () => {
    const selected = provider();
    const config = configuration();
    let current = true;
    await activatePrivyWallet(config, wallet(selected), () => current);
    const client = await getWalletClient(config);
    current = false;
    await disconnect(config);
    selected.emit("accountsChanged", [ALICE]);
    selected.emit("chainChanged", "0x1");
    await flush();
    await expect(client.sendTransaction({ account: client.account, chain: baseSepolia, to: TOKEN, value: 1n })).rejects.toThrow("cancelled");
    expect(selected.request.mock.calls.some(([call]) => call.method === "eth_sendTransaction")).toBe(false);
    expect(getAccount(config).status).toBe("disconnected");
    expect(config.state.connections.size).toBe(0);
  });
});
