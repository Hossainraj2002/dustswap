import type { Address } from "@/core/types";

export interface MemefunWallet {
  mode: "demo" | "privy";
  status: "disconnected" | "connecting" | "connected";
  address: Address | null;
  chainId: number | null;
  onBase: boolean;
  isSwitching: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchToBase: () => Promise<void>;
}

/* A Connect tap before the wallet host has loaded is remembered here and
 * replayed by the host as soon as it mounts. */
let pendingConnect = false;

export function requestConnectWhenReady() {
  pendingConnect = true;
}

export function consumePendingConnect(): boolean {
  const pending = pendingConnect;
  pendingConnect = false;
  return pending;
}
