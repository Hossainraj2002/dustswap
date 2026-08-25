// A check-in or streak-restore payment leaves the wallet before the API is ever told about it.
// If the tab reloads, the wallet popup steals focus, or the receipt poll stalls in between, the
// hash is lost with it: the money is gone on-chain and the streak never moves, and nothing in the
// UI can redeem an existing payment. Writing the hash down the moment it exists lets the next page
// load finish the job instead.

export type PendingPaymentKind = "check-in" | "streak-save";

export type PendingCheckInPayment = {
  kind: PendingPaymentKind;
  address: string;
  txHash: string;
  asset: "eth" | "usdc";
  createdAt: number;
};

const STORAGE_PREFIX = "dustswap.pending-payment";

// The API only honours a restore payment for a bounded window, so a record older than that can
// never be redeemed and is dropped rather than retried on every page load forever.
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

function storageKey(kind: PendingPaymentKind, address: string) {
  return `${STORAGE_PREFIX}.${kind}.${address.toLowerCase()}`;
}

function readStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    // Private mode and hardened browser profiles can throw on access alone.
    return null;
  }
}

export function rememberPendingPayment(payment: PendingCheckInPayment) {
  const storage = readStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(storageKey(payment.kind, payment.address), JSON.stringify(payment));
  } catch {
    // A full or blocked storage must never break the payment flow that is already in progress.
  }
}

export function readPendingPayment(kind: PendingPaymentKind, address: string) {
  const storage = readStorage();
  if (!storage) {
    return null;
  }

  const key = storageKey(kind, address);

  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PendingCheckInPayment>;
    const txHash = String(parsed.txHash || "");
    const createdAt = Number(parsed.createdAt || 0);

    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !Number.isFinite(createdAt)) {
      storage.removeItem(key);
      return null;
    }

    if (Date.now() - createdAt > MAX_AGE_MS) {
      storage.removeItem(key);
      return null;
    }

    return {
      kind,
      address: address.toLowerCase(),
      txHash,
      asset: parsed.asset === "usdc" ? "usdc" : "eth",
      createdAt,
    } as PendingCheckInPayment;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing else to do: an unreadable record is simply ignored.
    }
    return null;
  }
}

export function clearPendingPayment(kind: PendingPaymentKind, address: string) {
  const storage = readStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(storageKey(kind, address));
  } catch {
    // Ignored for the same reason as above.
  }
}

// Every error the points API returns arrives as HTTP 400, so the message is the only signal for
// whether retrying could ever help. These mean the hash is settled one way or another; anything
// else (a stalled RPC, a database blip, a tx that is not mined yet) stays on disk for a retry.
const SETTLED_ERROR_PATTERNS = [
  "already been used",
  "already checked in today",
  "no broken streak",
  "recovery is currently disabled",
  "was not sent to",
  "below the required amount",
  "sender does not match",
  "was not found in this transaction",
  "must be mined today",
];

export function isSettledPaymentError(message: string | null | undefined) {
  const normalized = String(message || "").toLowerCase();
  return SETTLED_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}
