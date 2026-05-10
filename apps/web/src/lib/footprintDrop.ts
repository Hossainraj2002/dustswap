import { publicApiFetch } from "@/lib/apiBase";
import { getPointsApiUrl } from "@/lib/points";

export type FootprintDropSource = "saved_leaderboard" | "blockscout";

export type FootprintClaimConfig = {
  chainId: number;
  recipient: string;
  usdcAddress: string;
  usdTarget: number;
  usdcAmount: string;
  usdcAmountUnits: string;
  ethAmountWei: string;
  ethAmountDisplay: string;
  ethPriceUsd: number;
  priceDate: string;
};

export type FootprintDropStatus = {
  success: boolean;
  address: string;
  eligible: boolean;
  claimed: boolean;
  claimable: boolean;
  alreadyClaimed?: boolean;
  rewardPoints: number;
  totalPoints?: number;
  source: FootprintDropSource | null;
  rangeMin: number | null;
  rangeMax: number | null;
  tierLabel: string | null;
  reason: string | null;
  allowlistTotalUsdc: number | null;
  transactionsCount: number | null;
  tokenTransfersCount: number | null;
  totalActivity: number | null;
  claimedAt: string | null;
  claimConfig?: FootprintClaimConfig | null;
  footprintFollowVerified?: boolean;
  referralCommissionPct: number;
  error?: string;
};

async function parseJson<T>(response: Response) {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function lookupFootprintDrop(address: string) {
  const response = await publicApiFetch(getPointsApiUrl("/airdrop/lookup"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
    cache: "no-store",
  });

  const data = await parseJson<FootprintDropStatus>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Failed to check Footprint Drop");
  }

  return data;
}

export async function claimFootprintDrop(
  input:
    | string
    | {
        address: string;
        asset?: "eth" | "usdc";
        txHash?: string;
      }
) {
  const response = await publicApiFetch(getPointsApiUrl("/airdrop/claim"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      typeof input === "string"
        ? { address: input }
        : {
            address: input.address,
            asset: input.asset,
            txHash: input.txHash,
          }
    ),
    cache: "no-store",
  });

  const data = await parseJson<FootprintDropStatus>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Failed to claim Footprint Drop");
  }

  return data;
}

export async function verifyFootprintFollow(input: {
  address: string;
  taskKey: string;
}) {
  const response = await publicApiFetch(getPointsApiUrl("/airdrop/verify-follow"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  });

  const data = await parseJson<{
    success: boolean;
    verified?: boolean;
    taskKey?: string;
    targetUsername?: string;
    targetXUserId?: string;
    sourceXUserId?: string;
    verifiedAt?: string | null;
    message?: string;
    error?: string;
  }>(response);

  if (!response.ok && !data.success) {
    throw new Error(data.error || "Failed to verify X follow");
  }

  return data;
}
