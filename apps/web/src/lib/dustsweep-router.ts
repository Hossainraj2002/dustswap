import { type Address, type Hex } from "viem";

// ── Real compiled ABI from DustSweepRouter.sol ──
// Import from the canonical compiled JSON rather than maintaining inline duplicates.
// This is the source of truth — any ABI duplication across the codebase is a bug.
import DustSweepRouterABI from "@/abi/DustSweepRouter.json";

export const DUST_SWEEP_ROUTER_ADDRESS = (process.env
  .NEXT_PUBLIC_DUST_SWEEP_ROUTER ||
  process.env.NEXT_PUBLIC_DUST_SWEEP_ROUTER_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

export const dustSweepRouterAbi = DustSweepRouterABI;

// V1 contract cap — must be respected until V2 is deployed
export const V1_MAX_BATCH_SIZE = 10;

/**
 * The backend now provides canonical calldata via POST /build-tx.
 * Frontend should NOT re-encode — use the backend's calldata directly.
 *
 * This function is DEPRECATED and kept only for backward compatibility.
 * All new code should use the backend-provided calldata from build-tx response.
 *
 * @deprecated Use backend canonical calldata from POST /build-tx instead.
 */
export function encodeDustSweepPermit2Calldata(_args: {
  routes: unknown[];
  tokenOut: Address;
  receiver: Address;
  deadline: number;
  permit2Nonce: string;
  signature: Hex;
}): Hex {
  throw new Error(
    "encodeDustSweepPermit2Calldata is deprecated. " +
    "Use the canonical calldata from POST /api/dustsweep/build-tx response instead. " +
    "The old phantom sweep() ABI does not exist in the deployed contract.",
  );
}

export function parseDustSweepError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "");
  const lower = raw.toLowerCase();

  if (lower.includes("deadlineexpired")) return "Deadline expired. Refreshing quote.";
  if (lower.includes("signatureexpired")) return "Deadline expired. Refreshing quote.";
  if (lower.includes("invalidnonce")) return "Permit already used. Refresh quote and try again.";
  if (lower.includes("insufficientoutput")) return "Slippage exceeded, try again or increase slippage.";
  if (lower.includes("batchtoolarge")) return `DustSweep can sweep up to ${V1_MAX_BATCH_SIZE} tokens in one batch (V1 contract limit).`;
  if (lower.includes("toomanytokens")) return `DustSweep can sweep up to ${V1_MAX_BATCH_SIZE} tokens in one batch.`;
  if (lower.includes("zerotokens")) return "Select at least one token to sweep.";
  if (lower.includes("emptyorders")) return "Select at least one token to sweep.";
  if (lower.includes("permitlengthmismatch")) return "Permit data did not match the selected tokens.";
  if (lower.includes("permit2 approval required")) return "Approve the selected tokens and try again.";
  if (lower.includes("transfer_from_failed")) return "Permit2 could not pull one token. Refresh balances, approve tokens, and try again.";
  if (lower.includes("transfer amount exceeds balance")) return "One token balance changed. Refresh and try again.";
  if (lower.includes("token balance changed")) return "One token balance changed. Refresh and try again.";
  if (lower.includes("user rejected") || lower.includes("rejected")) return "Transaction cancelled";
  if (lower.includes("route_cap_exceeded")) return `Too many tokens selected. Maximum ${V1_MAX_BATCH_SIZE} per sweep.`;

  return raw || "Transaction failed";
}
