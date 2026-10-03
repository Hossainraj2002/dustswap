import type { Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { ApiClient } from "./api";
import type { TxWallet } from "./tx";
import { toTxError } from "./txErrors";

/**
 * Sign-In with Ethereum for the API's signed-in actions (comments). One signature per wallet per
 * browser session: the API's session token is kept in sessionStorage until it expires.
 */
export interface Session {
  address: Address;
  token: string;
  expiresAt: number;
}

const storageKey = (address: string) => `memefun:session:${address.toLowerCase()}`;
/** Sign in again a minute before the token would expire. */
const EXPIRY_MARGIN_MS = 60_000;

export function loadSession(address: string, now = Date.now()): Session | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(address));
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    if (typeof session.token !== "string" || !(session.expiresAt - EXPIRY_MARGIN_MS > now)) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session) {
  try {
    window.sessionStorage.setItem(storageKey(session.address), JSON.stringify(session));
  } catch {
    // Storage blocked: the session lasts for this page only.
  }
}

export function clearSession(address: string) {
  try {
    window.sessionStorage.removeItem(storageKey(address));
  } catch {
    // Ignore.
  }
}

export async function signIn(api: ApiClient, wallet: TxWallet, chainId: number, location: { host: string; origin: string } = window.location): Promise<Session> {
  const address = wallet.account.address;
  const { nonce } = await api.post<{ nonce: string }>("/v1/auth/nonce", {});
  const now = new Date();
  const message = createSiweMessage({
    address,
    chainId,
    domain: location.host,
    uri: location.origin,
    nonce,
    version: "1",
    statement: "Sign in to memefun. This proves you own this wallet. It sends no transaction and costs nothing.",
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60_000),
  });
  let signature: `0x${string}`;
  try {
    signature = await wallet.signMessage({ account: wallet.account, message });
  } catch (error) {
    throw toTxError(error, "Sign-in did not complete.");
  }
  const result = await api.post<{ address: Address; token: string; expiresAt: string }>("/v1/auth/verify", { address, message, signature });
  return { address, token: result.token, expiresAt: Date.parse(result.expiresAt) };
}
