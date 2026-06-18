import { type Address, type Hex } from "viem";

type AtomicStatus = "ready" | "supported" | "unsupported" | "unknown";

export type WalletRpcRequest = (args: {
  method: string;
  params?: unknown[];
}) => Promise<unknown>;

export type WalletRpcCall = {
  to: Address;
  data: Hex;
  value?: bigint;
  capabilities?: Record<string, unknown>;
};

export type WalletRequestCandidateOptions = {
  preferInjected?: boolean;
  limit?: number;
};

/**
 * OKX reports `ready` before its one-time EIP-7702 upgrade. Sending an atomic
 * batch in that state lets the wallet submit the upgrade before the requested
 * calls, which users reasonably perceive as an empty transaction. An existing
 * OKX delegation can still batch when capability probing is flaky; an explicit
 * `unsupported` response remains authoritative.
 */
export function canSubmitOkxBatchWithoutUpgrade(args: {
  atomicStatus: AtomicStatus;
  hasOwnDelegation: boolean;
}) {
  if (args.hasOwnDelegation) {
    return args.atomicStatus !== "unsupported";
  }

  return args.atomicStatus === "supported";
}

export function orderWalletRequestCandidates(
  clientCandidates: WalletRpcRequest[],
  injectedCandidates: WalletRpcRequest[],
  options?: WalletRequestCandidateOptions,
) {
  const candidates = options?.preferInjected
    ? [...injectedCandidates, ...clientCandidates]
    : [...clientCandidates, ...injectedCandidates];

  return typeof options?.limit === "number"
    ? candidates.slice(0, options.limit)
    : candidates;
}

function toRpcQuantity(value?: bigint) {
  return `0x${(value ?? 0n).toString(16)}`;
}

function assertPopulatedContractCall(call: WalletRpcCall, index: number) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(call.to)) {
    throw new Error(`Wallet batch call ${index + 1} has an invalid target`);
  }

  if (
    !/^0x[a-fA-F0-9]+$/.test(call.data) ||
    call.data.length < 10 ||
    call.data.length % 2 !== 0
  ) {
    throw new Error(`Wallet batch call ${index + 1} has empty or invalid calldata`);
  }
}

export function buildWalletSendCallsPayload(args: {
  account: Address;
  chainId: number;
  calls: WalletRpcCall[];
  atomicRequired: boolean;
  capabilities?: Record<string, unknown>;
}) {
  if (args.calls.length === 0) {
    throw new Error("Wallet batch has no calls");
  }

  const calls = args.calls.map((call, index) => {
    assertPopulatedContractCall(call, index);
    return {
      to: call.to,
      data: call.data,
      value: toRpcQuantity(call.value),
      ...(call.capabilities ? { capabilities: call.capabilities } : {}),
    };
  });

  return {
    version: "2.0.0",
    atomicRequired: args.atomicRequired,
    chainId: `0x${args.chainId.toString(16)}`,
    from: args.account,
    calls,
    ...(args.capabilities ? { capabilities: args.capabilities } : {}),
  };
}

export function requestWalletSendCalls(
  request: WalletRpcRequest,
  payload: ReturnType<typeof buildWalletSendCallsPayload>,
) {
  return request({
    method: "wallet_sendCalls",
    params: [payload],
  });
}
