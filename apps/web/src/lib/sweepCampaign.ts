import type { Hex } from "viem";
import { buildPublicApiUrl, publicApiFetch } from "./apiBase";

// Client for the DustSweep rewards campaign ("Sweep $500 → Earn $10").
// Reads are unauthenticated (viewer address as a query param, like the
// leaderboard hub); tier claims are authorized by a per-action wallet
// signature over a structured plaintext message (profile-completion pattern).

export const SWEEP_CAMPAIGN_ENABLED =
  process.env.NEXT_PUBLIC_SWEEP_CAMPAIGN_ENABLED === "true";

const CLAIM_STATEMENT = "DustSwap Sweep Campaign Claim";
const STATUS_CACHE_TTL_MS = 30 * 1000;

export type CampaignPhase = "upcoming" | "live" | "grace" | "closed";

export type CampaignTier = {
  tier: number;
  thresholdUsd: number;
  rewardUsdc: number;
};

export type CampaignPrize = {
  rankFrom: number;
  rankTo: number;
  prizeUsdc: number;
  prizePp: number;
};

export type CampaignTierStatus =
  | "locked"
  | "claimable"
  | "processing"
  | "paid"
  | "failed";

export type CampaignTierState = CampaignTier & {
  status: CampaignTierStatus;
  payoutTxHash: string | null;
};

export type CampaignMeta = {
  slug: string;
  name: string;
  chainId: number;
  startsAt: string;
  endsAt: string;
  claimGraceDays: number;
  volumeCapUsd: number;
  tiers: CampaignTier[];
  prizes: CampaignPrize[];
};

export type CampaignViewer = {
  address: string;
  volumeUsd: number;
  cappedVolumeUsd: number;
  verifiedSweepCount: number;
  pendingCount: number;
  tiers: CampaignTierState[];
  totalClaimableUsdc: number;
  totalPaidUsdc: number;
};

export type CampaignStatus = {
  success: boolean;
  active: boolean;
  phase?: CampaignPhase;
  /**
   * Whether a claim made right now would pay out promptly. Carries no reason by
   * design: the UI shows a neutral "opening soon" rather than anything about
   * the reward wallet.
   */
  payoutsAvailable?: boolean;
  campaign?: CampaignMeta;
  viewer?: CampaignViewer;
  error?: string;
};

export type CampaignLeaderboardEntry = {
  rank: number;
  address: string;
  volumeUsd: number;
  sweepCount: number;
  prizeUsdc: number | null;
  prizePp: number | null;
};

export type CampaignLeaderboardViewer = CampaignLeaderboardEntry;

export type CampaignLeaderboard = {
  success: boolean;
  active: boolean;
  phase?: CampaignPhase;
  campaign?: { slug: string; startsAt: string; endsAt: string };
  prizes?: CampaignPrize[];
  entries: CampaignLeaderboardEntry[];
  viewer: CampaignLeaderboardViewer | null;
  page?: number;
  pageSize?: number;
  error?: string;
};

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("Unexpected response from the campaign API.");
  }
}

type CacheEntry<T> = { value: T; expiresAt: number };
const statusCache = new Map<string, CacheEntry<CampaignStatus>>();
const inflightStatus = new Map<string, Promise<CampaignStatus>>();

export function invalidateCampaignCache() {
  statusCache.clear();
}

export async function fetchCampaignStatus(
  address?: string | null,
  options?: { force?: boolean }
): Promise<CampaignStatus> {
  const key = (address || "anon").toLowerCase();

  if (!options?.force) {
    const cached = statusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const inflight = inflightStatus.get(key);
    if (inflight) {
      return inflight;
    }
  }

  const url = new URL(buildPublicApiUrl("/api/dustsweep/campaign/status"));
  if (address) {
    url.searchParams.set("address", address);
  }

  const request = (async () => {
    const response = await publicApiFetch(url.toString(), {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    const data = await parseJson<CampaignStatus>(response);
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Failed to load campaign status.");
    }
    statusCache.set(key, { value: data, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
    return data;
  })().finally(() => {
    inflightStatus.delete(key);
  });

  inflightStatus.set(key, request);
  return request;
}

export async function fetchCampaignLeaderboard(input?: {
  page?: number;
  pageSize?: number;
  viewerAddress?: string | null;
}): Promise<CampaignLeaderboard> {
  const url = new URL(buildPublicApiUrl("/api/dustsweep/campaign/leaderboard"));
  url.searchParams.set("page", String(input?.page || 1));
  url.searchParams.set("pageSize", String(input?.pageSize || 50));
  if (input?.viewerAddress) {
    url.searchParams.set("viewer", input.viewerAddress);
  }

  const response = await publicApiFetch(url.toString(), {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  const data = await parseJson<CampaignLeaderboard>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Failed to load campaign leaderboard.");
  }
  return data;
}

function createNonce() {
  const browserCrypto = typeof crypto !== "undefined" ? crypto : null;
  if (browserCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildCampaignClaimMessage(
  address: string,
  campaignSlug: string,
  tier: number
) {
  const domain =
    typeof window !== "undefined" ? window.location.host : "localhost:3000";

  return [
    CLAIM_STATEMENT,
    `Address: ${address}`,
    `Campaign: ${campaignSlug}`,
    `Tier: ${tier}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Nonce: ${createNonce()}`,
    `Domain: ${domain}`,
  ].join("\n");
}

export type CampaignClaimResult = {
  success: boolean;
  claim?: { tier: number; amountUsdc: number; status: string };
  error?: string;
};

export async function claimCampaignTier(input: {
  address: string;
  tier: number;
  message: string;
  signature: Hex;
}): Promise<CampaignClaimResult> {
  const response = await publicApiFetch(
    buildPublicApiUrl("/api/dustsweep/campaign/claim"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );

  const data = await parseJson<CampaignClaimResult>(response);
  if (!response.ok || !data.success) {
    const claimError = new Error(data.error || "Failed to claim the reward.");
    Object.assign(claimError, { payload: data, status: response.status });
    throw claimError;
  }

  invalidateCampaignCache();
  return data;
}

export function formatCampaignUsd(value: number) {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value >= 1000 ? 0 : 2,
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  })}`;
}

export function formatCampaignPp(value: number) {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M PP`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k PP`;
  }
  return `${value} PP`;
}

export function getCampaignDaysLeft(endsAt: string): number {
  const remaining = Date.parse(endsAt) - Date.now();
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}
