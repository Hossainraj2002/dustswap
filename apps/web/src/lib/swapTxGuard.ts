export const SWAP_ROUTE_UNAVAILABLE_ERROR_MESSAGE =
  "Swap route is unavailable or invalid. Please refresh the quote, change token/amount, or try again.";

export const SWAP_REFERRER_TAMPERED_ERROR_MESSAGE =
  "This swap was modified by a browser extension and was blocked to protect your funds. Disable extensions such as Pocket Universe for app.dustswap.wtf, then refresh and try again.";

export const ZERO_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";

// DustSwap's OpenOcean referrer. Every legitimate DustSwap swap embeds this
// address in the OpenOcean calldata (certified across ~200k on-chain swaps). If a
// swap targets an OpenOcean router but this address is absent, an extension has
// stripped/replaced our referrer to divert the fee — that swap is tampered.
export const OPENOCEAN_REFERRER_ADDRESS = (
  process.env.NEXT_PUBLIC_OPENOCEAN_REFERRER_ADDRESS ||
  "0x0fd79f3ceaE7ddA5cFC15b35188E67EFAc542573"
).toLowerCase();

const OPENOCEAN_REFERRER_BARE = OPENOCEAN_REFERRER_ADDRESS.replace(/^0x/, "");
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

// Kill-switch: set NEXT_PUBLIC_SWAP_REFERRER_GUARD=off to disable the hard block
// without a redeploy (Layer B on-chain detection stays active regardless).
export function isSwapReferrerGuardEnabled() {
  const raw = (process.env.NEXT_PUBLIC_SWAP_REFERRER_GUARD || "on")
    .trim()
    .toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

export type WalletCall = {
  to?: unknown;
  value?: unknown;
  data?: unknown;
};

export type WalletSendCallsRequest = {
  from?: string;
  chainId?: string | number;
  calls?: WalletCall[];
};

export type InvalidSwapTxReason =
  | "missing_to"
  | "zero_to"
  | "invalid_to"
  | "empty_calldata_zero_value";

export type InvalidWalletSendCallsReason = InvalidSwapTxReason | "missing_calls";

export type WalletSendCallsValidationResult = {
  reason: InvalidWalletSendCallsReason;
  call?: WalletCall;
  callIndex?: number;
};

export function isValidEvmAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function isZeroValue(value: unknown) {
  if (value == null) {
    return true;
  }

  if (typeof value === "bigint") {
    return value === 0n;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value === 0;
  }

  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "0x") {
    return true;
  }

  try {
    if (/^0x[a-f0-9]+$/.test(normalized) || /^[0-9]+$/.test(normalized)) {
      return BigInt(normalized) === 0n;
    }
  } catch {
    return false;
  }

  return false;
}

function isEmptyCalldata(value: unknown) {
  if (value == null) {
    return true;
  }

  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return !normalized || normalized === "0x" || normalized === "0x0" || normalized === "0x0x";
}

export function getInvalidSwapTxReason(
  tx: WalletCall | Record<string, unknown> | null | undefined
): InvalidSwapTxReason | null {
  const to = typeof tx?.to === "string" ? tx.to : "";
  const normalizedTo = to.trim().toLowerCase();

  if (!normalizedTo) {
    return "missing_to";
  }

  if (normalizedTo === "0x0" || normalizedTo === ZERO_EVM_ADDRESS) {
    return "zero_to";
  }

  if (!isValidEvmAddress(to)) {
    return "invalid_to";
  }

  if (isEmptyCalldata(tx?.data) && isZeroValue(tx?.value)) {
    return "empty_calldata_zero_value";
  }

  return null;
}

/**
 * Detect that a swap call targeting an OpenOcean router has had DustSwap's
 * referrer stripped/replaced (fee-diversion by a browser extension).
 *
 * Returns `"referrer_stripped"` ONLY when: the call goes to an OpenOcean router,
 * carries real swap calldata (not an ERC-20 approval), and does not contain our
 * referrer address. Legitimate swaps always contain it, so this cannot fire on a
 * genuine DustSwap swap. `isOpenOceanRouter` is injected by the caller to avoid a
 * module cycle.
 */
export function getSwapReferrerTamperReason(
  tx: WalletCall | Record<string, unknown> | null | undefined,
  isOpenOceanRouter: (address: string) => boolean
): "referrer_stripped" | null {
  const to = typeof tx?.to === "string" ? tx.to.trim().toLowerCase() : "";
  if (!to || !isOpenOceanRouter(to)) {
    return null;
  }

  const data = typeof tx?.data === "string" ? tx.data.trim().toLowerCase() : "";
  // No calldata, or a plain ERC-20 approval — nothing referrer-bearing to check.
  if (!data || data === "0x" || data.startsWith(ERC20_APPROVE_SELECTOR)) {
    return null;
  }

  return data.includes(OPENOCEAN_REFERRER_BARE) ? null : "referrer_stripped";
}

export function validateWalletSendCalls(
  request: WalletSendCallsRequest | null | undefined
): WalletSendCallsValidationResult | null {
  const calls = Array.isArray(request?.calls) ? request.calls : [];

  if (calls.length === 0) {
    return { reason: "missing_calls" };
  }

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const reason = getInvalidSwapTxReason(call);

    if (reason) {
      return {
        reason,
        call,
        callIndex: index,
      };
    }
  }

  return null;
}
