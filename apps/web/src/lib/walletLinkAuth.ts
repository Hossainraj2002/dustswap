import { concat, parseEther, sha256, stringToBytes, type Hex } from "viem";
import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";
import { DATA_SUFFIX } from "@/lib/builderCode";

export type WalletLinkAction =
  | "create-link-request"
  | "confirm-link"
  | "unlink-wallet";

const WALLET_LINK_STATEMENT = "DustSwap Wallet Linking";

// Base App mini-app deep-link base. Opening this in Base App launches DustSwap
// as a mini app at the appended path (confirmed working format). Override only
// if the app domain changes.
export const BASE_APP_LINK_BASE = (
  process.env.NEXT_PUBLIC_BASE_APP_LINK_BASE || "https://base.app/app/app.dustswap.wtf"
).replace(/\/+$/, "");

// Build the Base App deep link for a wallet-link token. Base App preserves the
// URL path but strips query strings, so the token rides in the path:
// https://base.app/app/app.dustswap.wtf/link/<token>
export function buildBaseAppLink(token: string) {
  return `${BASE_APP_LINK_BASE}/link/${encodeURIComponent(token)}`;
}

// Wallet-link confirmation is a free (0 ETH) on-chain verification tx to the
// recipient (builder-code attributed, token-hash bound), instead of a bare
// signature. The user only pays network gas.
export const WALLET_LINK_RECIPIENT = (process.env.NEXT_PUBLIC_WALLET_LINK_RECIPIENT ||
  "0x72Bd4b89fFb1e1f48253b7a7a65739ff1E696442") as `0x${string}`;
export const WALLET_LINK_PAYMENT_ETH =
  process.env.NEXT_PUBLIC_WALLET_LINK_PAYMENT_ETH || "0";

// Build the confirm-link payment tx. The token's sha256 (== the backend's
// stored token_hash) is embedded in the calldata so the backend can bind the
// payment to THIS link; the ERC-8021 builder-code suffix attributes the tx.
// Recipient/amount come from the backend (link-request response) so they always
// match what the backend verifies; fall back to defaults if absent.
export function buildLinkPaymentTx(
  token: string,
  opts?: { to?: string; eth?: string }
): {
  to: `0x${string}`;
  value: bigint;
  data: Hex;
} {
  const tokenHash = sha256(stringToBytes(token));
  const to = (opts?.to || WALLET_LINK_RECIPIENT) as `0x${string}`;
  const eth = opts?.eth || WALLET_LINK_PAYMENT_ETH;
  return {
    to,
    value: parseEther(eth),
    data: concat([tokenHash, DATA_SUFFIX]),
  };
}

export type LinkRequestPreview = {
  shortAddress: string;
  displayName: string | null;
  username: string | null;
  pfpUrl: string | null;
  totalPoints: number;
  currentStreak: number;
};

export type LinkedWallet = {
  wallet_address: string;
  wallet_type: string;
  is_primary: boolean;
  linked_at: string;
};

function parseJson<T>(response: Response): Promise<T> {
  return response.text().then((text) => (text ? (JSON.parse(text) as T) : ({} as T)));
}

function createNonce() {
  const browserCrypto =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (browserCrypto?.randomUUID) {
    return browserCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (browserCrypto?.getRandomValues) {
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildWalletLinkMessage(input: {
  address: string;
  action: WalletLinkAction;
  token?: string;
  wallet?: string;
}) {
  const domain =
    typeof window !== "undefined" ? window.location.host : "localhost:3000";

  const lines = [
    WALLET_LINK_STATEMENT,
    `Address: ${input.address}`,
    `Action: ${input.action}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Nonce: ${createNonce()}`,
    `Domain: ${domain}`,
  ];

  if (input.token) {
    lines.push(`Token: ${input.token}`);
  }
  if (input.wallet) {
    lines.push(`Wallet: ${input.wallet}`);
  }

  return lines.join("\n");
}

function apiUrl(path: string) {
  return buildPublicApiUrl(`/api/wallet-link${path}`);
}

export async function createWalletLinkRequest(input: {
  address: string;
  message: string;
  signature: Hex;
}) {
  const response = await publicApiFetch(apiUrl("/create-link-request"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJson<{
    success?: boolean;
    url?: string;
    token?: string;
    expiresAt?: string;
    bonusPp?: number;
    error?: string;
  }>(response);
  if (!response.ok || !data.success || !data.url) {
    throw new Error(data.error || "Could not create a wallet link.");
  }
  return {
    url: data.url,
    token: data.token || "",
    expiresAt: data.expiresAt || "",
    bonusPp: Number(data.bonusPp || 0),
  };
}

export async function fetchWalletLinkRequest(token: string) {
  const url = new URL(apiUrl("/get-link-request"));
  url.searchParams.set("token", token);
  const response = await fetch(url.toString(), { cache: "no-store" });
  const data = await parseJson<{
    success?: boolean;
    preview?: LinkRequestPreview;
    bonusPp?: number;
    paymentTo?: string;
    paymentEth?: string;
    expiresAt?: string;
    error?: string;
  }>(response);
  if (!response.ok || !data.success || !data.preview) {
    throw new Error(data.error || "This link is invalid or has expired.");
  }
  return {
    preview: data.preview,
    bonusPp: Number(data.bonusPp || 0),
    paymentTo: data.paymentTo || WALLET_LINK_RECIPIENT,
    paymentEth: data.paymentEth || WALLET_LINK_PAYMENT_ETH,
    expiresAt: data.expiresAt || "",
  };
}

export async function confirmWalletLink(input: {
  token: string;
  address: string;
  txHash?: string;
}) {
  const response = await publicApiFetch(apiUrl("/confirm-link"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJson<{
    success?: boolean;
    alreadyLinked?: boolean;
    primaryAddress?: string;
    linkedWallet?: string;
    awardedPp?: number;
    newTotalPp?: number;
    error?: string;
  }>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Could not link your wallet.");
  }
  return {
    alreadyLinked: Boolean(data.alreadyLinked),
    primaryAddress: data.primaryAddress || "",
    linkedWallet: data.linkedWallet || input.address,
    awardedPp: Number(data.awardedPp || 0),
    newTotalPp: Number(data.newTotalPp || 0),
  };
}

export async function unlinkWallet(input: {
  address: string;
  walletToUnlink: string;
  message: string;
  signature: Hex;
}) {
  const response = await publicApiFetch(apiUrl("/unlink"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJson<{
    success?: boolean;
    detachedWallet?: string;
    newUserId?: number;
    error?: string;
  }>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Could not unlink this wallet.");
  }
  return {
    detachedWallet: data.detachedWallet || input.walletToUnlink,
    newUserId: Number(data.newUserId || 0),
  };
}

export async function fetchLinkedWallets(address: string) {
  const url = new URL(apiUrl("/wallets"));
  url.searchParams.set("address", address);
  const response = await fetch(url.toString(), { cache: "no-store" });
  const data = await parseJson<{
    success?: boolean;
    primaryAddress?: string;
    wallets?: LinkedWallet[];
    error?: string;
  }>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Could not load linked wallets.");
  }
  return {
    primaryAddress: data.primaryAddress || "",
    wallets: data.wallets || [],
  };
}
