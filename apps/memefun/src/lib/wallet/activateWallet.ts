import type { ConnectedWallet } from "@privy-io/react-auth";
import { getAddress, type EIP1193Provider } from "viem";
import type { Config } from "wagmi";
import { connect, disconnect } from "wagmi/actions";
import { injected } from "wagmi/connectors";
import { rememberWalletAccount } from "./walletAccount";

type Listener = (...args: unknown[]) => void;
type EventProvider = Pick<EIP1193Provider, "request"> & {
  on?: (event: string, listener: Listener) => void;
  removeListener?: (event: string, listener: Listener) => void;
};
let activationId = 0;
// Native connect writes state after asynchronous provider/storage work. Let it
// settle before another activation can write, even if its UI deadline expired.
const activationTails = new WeakMap<Config, Promise<void>>();

/** Activate only the wallet Privy selected, without another permissions prompt or SDK auto-reconnect. */
export async function activatePrivyWallet(
  config: Config,
  wallet: ConnectedWallet,
  isCurrent: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const address = getAddress(wallet.address);
  const id = `memefun.${wallet.meta.id}.${address.toLowerCase()}.${++activationId}`;
  let disposed = false;
  let committed = false;
  let provider: EventProvider | undefined;
  const listeners = new Map<string, Map<Listener, Listener>>();
  const current = () => !disposed && isCurrent();
  const check = () => {
    if (!current()) {
      dispose();
      throw new Error("Wallet connection was cancelled. Please connect again.");
    }
  };
  const dispose = () => {
    disposed = true;
    for (const [event, handlers] of listeners) for (const wrapper of handlers.values()) provider?.removeListener?.(event, wrapper);
    listeners.clear();
  };
  const removeStaleConnection = () => {
    if (current()) return;
    const state = config.state;
    const owned = [...state.connections].filter(([, entry]) => entry.connector.id === id);
    if (!owned.length) return;
    config.setState(previous => {
      const connections = new Map(previous.connections);
      for (const [uid] of owned) connections.delete(uid);
      const currentUid = previous.current && connections.has(previous.current)
        ? previous.current : [...connections.keys()].at(-1) ?? null;
      return { ...previous, connections, current: currentUid, status: currentUid ? "connected" : "disconnected" };
    });
  };
  // Core's final state write follows an asynchronous storage write. A timed-out
  // or cancelled activation must also discard that late write, preserving a newer wallet.
  const unsubscribe = config.subscribe(state => state.connections, removeStaleConnection);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { dispose(); reject(new Error("Your wallet did not finish connecting. Please try again.")); }, timeoutMs);
  });
  const operation = (async () => {
    provider = await Promise.race([wallet.getEthereumProvider(), deadline]) as unknown as EventProvider;
    check();
    const readAccounts = async () => {
      const accounts = await Promise.race([provider!.request({ method: "eth_accounts" }), deadline]);
      check();
      if (!Array.isArray(accounts) || !accounts.some(candidate => typeof candidate === "string" && candidate.toLowerCase() === address.toLowerCase())) {
        throw new Error("The selected wallet account is unavailable. Please choose it again.");
      }
      return [address];
    };
    await readAccounts();
    const adapted = {
      request: async (args: { method: string; params?: unknown }) => {
        check();
        // Privy's picker already authorized this account. Rebinding wagmi must
        // not prompt every remembered provider or use a different account.
        if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") return readAccounts();
        // Release native connect as well as the UI when a provider never replies.
        const result = await Promise.race([provider!.request(args as Parameters<EventProvider["request"]>[0]), deadline]);
        check();
        if (args.method === "eth_chainId" && !(typeof result === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(result) && Number.isSafeInteger(Number(result)) && Number(result) > 0)) {
          throw new Error("Your wallet returned an invalid network. Please reconnect.");
        }
        return result;
      },
      on: (event: string, handler: Listener) => {
        if (!current()) return;
        const handlers = listeners.get(event) ?? new Map<Listener, Listener>();
        if (handlers.has(handler)) return;
        const wrapper: Listener = (...args) => {
          if (!current()) { dispose(); return; }
          if (event === "accountsChanged") {
            const accounts = args[0];
            const selected = Array.isArray(accounts) && accounts.some(candidate => typeof candidate === "string" && candidate.toLowerCase() === address.toLowerCase());
            handler(selected ? [address] : []);
          } else handler(...args);
        };
        handlers.set(handler, wrapper);
        listeners.set(event, handlers);
        if (committed) provider!.on?.(event, wrapper);
      },
      removeListener: (event: string, handler: Listener) => {
        const handlers = listeners.get(event), wrapper = handlers?.get(handler);
        if (wrapper) provider!.removeListener?.(event, wrapper);
        handlers?.delete(handler);
      },
    } as unknown as EIP1193Provider;
    const previous = activationTails.get(config);
    const activation = (async () => {
      await previous?.catch(() => {});
      check();
      const existing = config.state.current && config.state.connections.get(config.state.current);
      // A queued duplicate must not create another connection for this choice.
      if (existing && existing.connector.id.startsWith(`memefun.${wallet.meta.id}.${address.toLowerCase()}.`) && existing.accounts.some(account => account.toLowerCase() === address.toLowerCase())) return;
      if (existing) {
        await disconnect(config, { connector: existing.connector });
        check();
      }
      await connect(config, { connector: injected({ target: { id, name: wallet.meta.name, provider: adapted }, shimDisconnect: false }) });
      check();
      const activated = config.state.current && config.state.connections.get(config.state.current);
      if (activated && activated.connector.id === id) rememberWalletAccount(activated.connector, wallet);
      committed = true;
      for (const [event, handlers] of listeners) for (const wrapper of handlers.values()) provider!.on?.(event, wrapper);
    })();
    activationTails.set(config, activation);
    void activation.finally(() => {
      if (activationTails.get(config) === activation) activationTails.delete(config);
    }).catch(() => {});
    await activation;
  })();
  // Keep guarding late commits until the underlying core action really settles.
  void operation.finally(() => { removeStaleConnection(); unsubscribe(); }).catch(() => {});
  try {
    await Promise.race([operation, deadline]);
  } catch (error) {
    dispose();
    removeStaleConnection();
    if (config.state.status === "connecting" && !config.state.current) config.setState(state => ({ ...state, status: "disconnected" }));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
