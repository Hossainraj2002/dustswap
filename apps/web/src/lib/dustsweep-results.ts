import { decodeEventLog, parseAbi, toEventSelector, type AbiEvent, type Address, type Hex } from "viem";
import type { DustSweepQuoteResponse } from "../types/dustsweep";

export const SWEEP_RECEIPT_EVENTS = parseAbi([
  "event DustSwept(address indexed user,address indexed recipient,address indexed outputToken,uint256 routeCount,uint256 grossAmountOut,uint256 feeAmount,uint256 netAmountOut)",
  "event DustSweepExecuted(address indexed user,address indexed receiver,address indexed outputToken,uint256 routeCount,uint256 grossAmountOut,uint256 feeAmount,uint256 netAmountOut)",
  "event DustSwept(address indexed sender,address indexed recipient,address indexed tokenOut,uint256 totalOutput,uint256 feeAmount,uint256 orderCount)",
  "event RouteExecuted(address indexed tokenIn,address indexed target,address indexed spender,uint256 amountIn)",
  "event RouteSkipped(address indexed tokenIn,uint256 amountIn,bytes reason)",
  "event InputRefunded(address indexed token,address indexed to,uint256 amount)",
  "event RefundFailed(address indexed token,address indexed to,uint256 amount)",
]);

export type SweepReceiptLog = { address: string; data: Hex; topics: readonly Hex[]; transactionHash?: Hex };
export type SweepReceiptResult = {
  grossAmountOut: bigint;
  feeAmount: bigint;
  netAmountOut: bigint;
  executedRouteCount: number;
  skippedRouteCount: number;
  // V1 is atomic but has no per-input events; null means use the submitted inputs.
  executedTokens: Address[] | null;
  skippedTokens: Address[];
  refundedTokens: Address[];
  refundFailedTokens: Address[];
};

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO = "0x0000000000000000000000000000000000000000";
const SETTLEMENT_TOPICS = new Set(SWEEP_RECEIPT_EVENTS
  .filter((event: AbiEvent) => event.name === "DustSwept" || event.name === "DustSweepExecuted")
  .map((event: AbiEvent) => toEventSelector(event).toLowerCase()));
function same(a: unknown, b: string) {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}
function unique(tokens: Address[]): Address[] {
  return [...new Map(tokens.map((token) => [token.toLowerCase(), token])).values()];
}

/** All chunks must be accounted for before displaying their combined received amount. */
export function combineSweepReceiptResults(results: Array<SweepReceiptResult | null>): SweepReceiptResult | null {
  if (results.length === 0 || results.some((result) => result === null)) return null;
  const known = results as SweepReceiptResult[];
  return {
    grossAmountOut: known.reduce((sum, result) => sum + result.grossAmountOut, 0n),
    feeAmount: known.reduce((sum, result) => sum + result.feeAmount, 0n),
    netAmountOut: known.reduce((sum, result) => sum + result.netAmountOut, 0n),
    executedRouteCount: known.reduce((sum, result) => sum + result.executedRouteCount, 0),
    skippedRouteCount: known.reduce((sum, result) => sum + result.skippedRouteCount, 0),
    executedTokens: known.some((result) => result.executedTokens === null)
      ? null : unique(known.flatMap((result) => result.executedTokens!)),
    skippedTokens: unique(known.flatMap((result) => result.skippedTokens)),
    refundedTokens: unique(known.flatMap((result) => result.refundedTokens)),
    refundFailedTokens: unique(known.flatMap((result) => result.refundFailedTokens)),
  };
}

/** Ignore DEX lookalike logs and unrelated sweeps in the same wallet transaction. */
export function parseSweepReceiptLogs(logs: readonly SweepReceiptLog[], scope: {
  routerAddress: Address;
  userAddress: Address;
  recipient: Address;
  outputToken: Address;
  transactionHash?: Hex;
}): SweepReceiptResult | null {
  const settlements: SweepReceiptResult[] = [];
  let executed: Address[] = [];
  let skipped: Address[] = [];
  let refunded: Address[] = [];
  let refundFailed: Address[] = [];
  for (const log of logs) {
    if (!same(log.address, scope.routerAddress) || log.topics.length === 0) continue;
    if (scope.transactionHash && log.transactionHash && !same(log.transactionHash, scope.transactionHash)) continue;
    try {
      const event = decodeEventLog({ abi: SWEEP_RECEIPT_EVENTS, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], strict: true }) as {
        eventName: string;
        args: Record<string, Address | bigint>;
      };
      const args = event.args;
      if (event.eventName === "RouteExecuted") executed.push(args.tokenIn as Address);
      else if (event.eventName === "RouteSkipped") skipped.push(args.tokenIn as Address);
      else if (event.eventName === "InputRefunded" && same(args.to, scope.userAddress)) refunded.push(args.token as Address);
      else if (event.eventName === "RefundFailed" && same(args.to, scope.userAddress)) refundFailed.push(args.token as Address);
      else if (event.eventName === "DustSwept" || event.eventName === "DustSweepExecuted") {
        const legacy = "totalOutput" in args;
        const output = legacy ? args.tokenOut : args.outputToken;
        const matchesOutput = same(output, scope.outputToken) ||
          (legacy && scope.outputToken.toLowerCase() === NATIVE && same(output, ZERO));
        if (same(legacy ? args.sender : args.user, scope.userAddress) &&
            same(args.receiver ?? args.recipient, scope.recipient) && matchesOutput) {
          const gross = (legacy ? args.totalOutput : args.grossAmountOut) as bigint;
          const fee = args.feeAmount as bigint;
          const v2 = event.eventName === "DustSweepExecuted";
          settlements.push({
            grossAmountOut: gross,
            feeAmount: fee,
            netAmountOut: legacy ? gross - fee : args.netAmountOut as bigint,
            executedRouteCount: legacy ? Number(args.orderCount) : v2 ? Number(args.routeCount) : executed.length,
            skippedRouteCount: skipped.length,
            executedTokens: legacy ? null : unique(executed),
            skippedTokens: unique(skipped),
            refundedTokens: unique(refunded),
            refundFailedTokens: unique(refundFailed),
          });
        }
        // Each settlement closes its own route/refund segment, even for another recipient.
        executed = []; skipped = []; refunded = []; refundFailed = [];
      }
    } catch {
      // A missing settlement cannot be silently merged with a later sweep or
      // omitted from the total. Keep the whole receipt's output unavailable.
      if (SETTLEMENT_TOPICS.has(log.topics[0].toLowerCase())) return null;
      // Unrelated or malformed logs are not evidence of output or route success.
    }
  }
  return combineSweepReceiptResults(settlements);
}

/** Router minAmountOut is one aggregate GROSS floor; settlement takes the fee afterward. */
export function getSweepMinimumReceiveRaw(quote: Pick<DustSweepQuoteResponse, "routes" | "minAmountOut" | "feeBps" | "wethUnwrap">): string | null {
  try {
    const unwrap = BigInt(quote.wethUnwrap?.amount ?? "0");
    if (quote.routes.length === 0) return unwrap > 0n ? unwrap.toString() : null;
    if (quote.minAmountOut == null) return null;
    const gross = BigInt(quote.minAmountOut);
    if (gross < 0n || !Number.isFinite(quote.feeBps)) return null;
    const feeBps = BigInt(Math.max(0, Math.min(10_000, Math.round(quote.feeBps))));
    return (gross - (gross * feeBps) / 10_000n + unwrap).toString();
  } catch {
    return null;
  }
}

/** Token amounts come from the receipt. USD remains an estimate at the quote's price. */
export function estimateReceiptOutputUsd(quote: Pick<DustSweepQuoteResponse, "totalEstimatedOut" | "totalEstimatedOutUSD">, amount: bigint): number | null {
  try {
    const quoted = BigInt(quote.totalEstimatedOut);
    if (quoted <= 0n || !(quote.totalEstimatedOutUSD > 0)) return null;
    const value = Number(amount) / Number(quoted) * quote.totalEstimatedOutUSD;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
