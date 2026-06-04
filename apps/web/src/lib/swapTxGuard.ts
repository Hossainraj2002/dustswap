export const SWAP_ROUTE_UNAVAILABLE_ERROR_MESSAGE =
  "Swap route is unavailable or invalid. Please refresh the quote, change token/amount, or try again.";

export const ZERO_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";

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
