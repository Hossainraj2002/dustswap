// SYNCED from apps/memefun/src/core/campaign.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
import type { Address } from "./types";

/** A separate, funded launch campaign; never part of a coin's trading-fee settings. */
export type LaunchCampaignSummary = { enabled: false } | {
  enabled: true;
  chainId: number;
  contract: Address;
  token: { address: Address; name: string; symbol: string; decimals: number };
  rewardAmountRaw: string;
  maxRecipients: 1000;
  claimedCount: number;
  qualifiedCount: number;
  startBlock: string;
  /** Zero until enabled. Applies only to launches at or after this block. */
  tradeRequiredFromBlock: string;
};

export interface LaunchCampaignWalletStatus {
  wallet: Address;
  state: "launch_required" | "confirming" | "trade_required" | "eligible" | "claimed" | "full";
  tradeRequired: boolean;
  slot?: number;
  coin?: Address;
  launchBlock?: string;
  tradeBlock?: string;
}

export interface LaunchCampaignClaimTicket {
  wallet: Address;
  slot: number;
  coin: Address;
  launchBlock: string;
  tradeBlock: string;
  deadline: number;
  signature: `0x${string}`;
}

export const LAUNCH_CAMPAIGN_DOMAIN_NAME = "MemeFunLaunchRewards";
export const LAUNCH_CAMPAIGN_TYPES = {
  Claim: [
    { name: "wallet", type: "address" },
    { name: "slot", type: "uint16" },
    { name: "coin", type: "address" },
    { name: "launchBlock", type: "uint256" },
    { name: "tradeBlock", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
