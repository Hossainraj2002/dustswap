import type { LaunchSettings } from "@/core/settings";
import type { FeeMode, QuoteKind } from "@/core/types";

/**
 * Turns validated settings changes into MemeFunConfig calls for the contract
 * owner to sign. The admin page validates the draft before preparing these calls.
 */
export interface OwnerCall {
  fn: string;
  args: string[];
  summary: string;
}

const MODE_INDEX: Record<FeeMode, number> = { creator: 0, burn: 1, holders: 2, floor: 3 };
const KIND_INDEX: Record<QuoteKind, number> = { native: 0, stable: 1, stock: 2, token: 3 };

function pct(bps: number) {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function ownerCalls(current: LaunchSettings, next: LaunchSettings): OwnerCall[] {
  const calls: OwnerCall[] = [];
  if (current.creationFeeEth !== next.creationFeeEth) {
    const wei = BigInt(Math.round(next.creationFeeEth * 1e9)) * 10n ** 9n;
    calls.push({ fn: "setCreationFee", args: [wei.toString()], summary: `Creation fee from ${current.creationFeeEth} ETH to ${next.creationFeeEth} ETH` });
  }
  if (current.feeMinBps !== next.feeMinBps || current.feeMaxBps !== next.feeMaxBps || current.defaultFeeBps !== next.defaultFeeBps) {
    calls.push({
      fn: "setFeeBounds",
      args: [String(next.feeMinBps), String(next.feeMaxBps), String(next.defaultFeeBps)],
      summary: `Trading fee range ${pct(next.feeMinBps)} to ${pct(next.feeMaxBps)}, suggested ${pct(next.defaultFeeBps)}`,
    });
  }
  if (current.platformShareBps !== next.platformShareBps) {
    calls.push({ fn: "setPlatformShareBps", args: [String(next.platformShareBps)], summary: `Platform share from ${pct(current.platformShareBps)} to ${pct(next.platformShareBps)} of each fee` });
  }
  if (current.referralShareBps !== next.referralShareBps) {
    calls.push({ fn: "setReferralShareBps", args: [String(next.referralShareBps)], summary: `Referral share from ${pct(current.referralShareBps)} to ${pct(next.referralShareBps)} of the platform share` });
  }
  if (current.creatorKeepMaxBps !== next.creatorKeepMaxBps) {
    calls.push({ fn: "setCreatorKeepMaxBps", args: [String(next.creatorKeepMaxBps)], summary: `Creator keep limit from ${pct(current.creatorKeepMaxBps)} to ${pct(next.creatorKeepMaxBps)}` });
  }
  if (current.snipeStartBps !== next.snipeStartBps || current.snipeDurationSec !== next.snipeDurationSec) {
    calls.push({
      fn: "setLaunchProtection",
      args: [String(next.snipeStartBps), String(next.snipeDurationSec)],
      summary: `Launch protection ${pct(next.snipeStartBps)} falling over ${next.snipeDurationSec}s`,
    });
  }
  if (current.openingFdvUsd !== next.openingFdvUsd) {
    calls.push({
      fn: "setOpeningFdvUsd",
      args: [(BigInt(Math.round(next.openingFdvUsd)) * 10n ** 8n).toString()],
      summary: `Opening market cap from $${current.openingFdvUsd.toLocaleString("en-US")} to $${next.openingFdvUsd.toLocaleString("en-US")}`,
    });
  }
  if (current.launchesPaused !== next.launchesPaused) {
    calls.push({ fn: "setLaunchesPaused", args: [String(next.launchesPaused)], summary: next.launchesPaused ? "Pause new launches" : "Resume new launches" });
  }
  for (const mode of Object.keys(MODE_INDEX) as FeeMode[]) {
    const was = current.enabledModes.includes(mode);
    const now = next.enabledModes.includes(mode);
    if (was !== now) calls.push({ fn: "setModeEnabled", args: [String(MODE_INDEX[mode]), String(now)], summary: `${now ? "Enable" : "Disable"} the ${mode} fee destination` });
  }
  for (const kind of Object.keys(KIND_INDEX) as QuoteKind[]) {
    const was = current.enabledQuoteKinds.includes(kind);
    const now = next.enabledQuoteKinds.includes(kind);
    if (was !== now) calls.push({ fn: "setQuoteKindEnabled", args: [String(KIND_INDEX[kind]), String(now)], summary: `${now ? "Enable" : "Disable"} ${kind} pairs` });
  }
  return calls;
}
