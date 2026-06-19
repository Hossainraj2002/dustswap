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
 * OKX supports EIP-7702: a `wallet_sendCalls` batch upgrades the connected EOA to
 * OKX's smart account (a one-time set-code authorization) and then runs the
 * requested calls as ONE atomic transaction. On an already-upgraded account the
 * same batch runs with no new authorization. This is OKX's documented path and
 * what gives the user a one-transaction sweep.
 *
 * DustSweep offers OKX the combined batch whenever it is SAFE and not opted out:
 * - the account must NOT sit on a FOREIGN delegate (another wallet's
 *   implementation — batching over it can conflict); a non-delegated account is
 *   safe, since the batch performs OKX's documented first-time upgrade, and so is
 *   the account already on OKX's own delegate.
 * - OKX must not explicitly report atomic batching as `unsupported`. A `ready`,
 *   `supported`, or even `unknown` probe still attempts the batch (OKX returns
 *   "Batch status unknown" in-app yet executes wallet_sendCalls fine).
 *
 * CRITICAL: send approvals + the sweep as ONE combined batch (see
 * shouldSplitOkxApprovalAndSweep). A standalone approval-only batch makes OKX's
 * security engine hard-block a "risky signature type" — a 7702 upgrade bundled
 * with bare token approvals and no consuming call reads like a drainer. The
 * combined approve→sweep batch reads as a normal swap and is accepted.
 */
export function canBatchOkxSweep(args: {
  atomicStatus: AtomicStatus;
  isDelegated: boolean;
  hasOwnDelegation: boolean;
}) {
  const onForeignDelegate = args.isDelegated && !args.hasOwnDelegation;
  return !onForeignDelegate && args.atomicStatus !== "unsupported";
}

/**
 * OKX never force-splits the approval batch from the sweep. Approvals + sweep go
 * out as ONE atomic wallet_sendCalls — the single transaction the combined-batch
 * path handles, and the only shape OKX's security engine accepts (a standalone
 * approval-only batch is hard-blocked as a "risky signature type"; see
 * canBatchOkxSweep). The only remaining split is the automatic one when a bundle
 * would exceed the wallet call cap, which the execution path handles on its own.
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
