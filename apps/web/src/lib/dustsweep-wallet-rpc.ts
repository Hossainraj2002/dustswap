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
 * OKX advertises atomic batching as a STATIC capability (`wallet_getCapabilities`
 * returns `supported`) even on a plain EOA that has NOT yet performed its
 * one-time EIP-7702 upgrade. Submitting a `wallet_sendCalls` (atomicRequired)
 * batch in that state forces OKX to sign an EIP-7702 set-code authorization
 * first, which OKX's own security engine now hard-blocks as a "risky signature
 * type" ("This transaction will be canceled to protect your assets").
 *
 * So only batch when the account is PROVEN to already sit on OKX's own delegate
 * (read on-chain via eth_getCode on Base). In that state wallet_sendCalls
 * executes through the existing delegate with no new authorization signature, so
 * OKX does not flag it. Without that proof — regardless of what the capability
 * probe claims — fall back to the standard approvals + sweep flow, which OKX
 * does not block. An explicit `unsupported` capability is still authoritative.
 */
export function canSubmitOkxBatchWithoutUpgrade(args: {
  atomicStatus: AtomicStatus;
  hasOwnDelegation: boolean;
}) {
  return args.hasOwnDelegation && args.atomicStatus !== "unsupported";
}

/**
 * OKX no longer force-splits the approval batch from the sweep. DustSweep only
 * batches OKX when the account is already on OKX's own EIP-7702 delegate (see
 * canSubmitOkxBatchWithoutUpgrade), and in that state approvals + sweep go out as
 * ONE atomic wallet_sendCalls — the single transaction the combined-batch path
 * handles. A standalone approval-only batch made OKX surface a separate "risky
 * signature type" prompt, so forcing the split is disabled; the only remaining
 * split is the automatic one when a bundle would exceed the wallet call cap,
 * which the execution path handles on its own.
 */
export function shouldSplitOkxApprovalAndSweep(_args: {
  isOkx: boolean;
  approvalCallCount: number;
}) {
  return false;
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
