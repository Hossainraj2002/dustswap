import { getPointsApiUrl } from "@/lib/points";

export type FootprintDropSource = "saved_leaderboard" | "blockscout";

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
  referralCommissionPct: number;
  error?: string;
};

async function parseJson<T>(response: Response) {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function lookupFootprintDrop(address: string) {
  const response = await fetch(getPointsApiUrl("/airdrop/lookup"), {
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

export async function claimFootprintDrop(address: string) {
  const response = await fetch(getPointsApiUrl("/airdrop/claim"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
    cache: "no-store",
  });

  const data = await parseJson<FootprintDropStatus>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Failed to claim Footprint Drop");
  }

  return data;
}
