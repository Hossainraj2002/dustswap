import type { SpinRewardKey, SpinRewardKind } from "@/lib/spin";
import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";
import { isTerminalReferralError } from "@/lib/referrals";

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export type PointsBalance = {
  success: boolean;
  totalPoints: number;
  rank: number;
  spinTickets: number;
  streak: number;
  rawStreak: number;
  recoverableStreak: number;
  longestStreak: number;
  referralCode: string;
  checkedInToday: boolean;
  streakStatus: "ready" | "active" | "checked_in" | "broken";
  boostPercent: number;
  recoverableBoostPercent: number;
  nextCheckInAt: string;
  dayEndsAt: string;
  lastCheckIn: string | null;
  checkInRewardPoints: number;
  nextBoostPercent: number;
  boostCapPercent: number;
  boostStepPercent: number;
  boostAppliesTo: string;
  streakLength: number;
  streakRecoveryEnabled: boolean;
  checkInConfig: {
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
  saveConfig: {
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
  error?: string;
};

export type SpinReward = {
  key: SpinRewardKey;
  label: string;
  type: SpinRewardKind;
  amount: number;
  pointsAwarded: number;
  probability: number;
};

export type SpinHistoryEntry = {
  id: number;
  txHash: string;
  reward: SpinReward;
  ticketCost: number;
  executionType: string;
  status: string;
  createdAt: string | null;
};

export type UserStats = {
  success: boolean;
  totalPoints: number;
  dustSwept: number;
  swapVolume: number;
  tokensBurned: number;
  error?: string;
};

export type ReferralStats = {
  success: boolean;
  code: string;
  friendsJoined: number;
  pointsEarned: number;
  unlocked?: boolean;
  hasReferrer?: boolean;
  error?: string;
};

export type PointsSummaryResponse = {
  success: boolean;
  balance: PointsBalance;
  stats: UserStats;
  referral: ReferralStats;
  error?: string;
};

export type LeaderboardEntry = {
  rank: number;
  address: string;
  points: number;
  streak: number;
  boostPercent?: number;
};

export type LeaderboardResponse = {
  success: boolean;
  page: number;
  limit: number;
  data: LeaderboardEntry[];
  error?: string;
};

export type LeaderboardBoardType = "particle_points" | "referral" | "volume";

export type CachedLeaderboardProfile = {
  fid: string | null;
  username: string | null;
  displayName: string | null;
  pfpUrl: string | null;
  updatedAt: string | null;
};

export type LeaderboardHubEntry = {
  rank: number;
  userId: number;
  address: string;
  totalPoints: number;
  referralPoints: number;
  referredUsers: number;
  swapVolume: number;
  profile: CachedLeaderboardProfile | null;
};

export type LeaderboardHubResponse = {
  success: boolean;
  type: LeaderboardBoardType;
  limit: number;
  page: number;
  pageSize: number;
  totalEntries: number;
  totalPages: number;
  totalUserCount: number;
  totalParticlePoints: number;
  viewer: LeaderboardHubEntry | null;
  entries: LeaderboardHubEntry[];
  error?: string;
};

const POINTS_SUMMARY_TTL_MS = 10_000;
const REFERRAL_APPLY_RECENT_TTL_MS = 15_000;
const pointsSummaryCache = new Map<
  string,
  {
    expiresAt: number;
    value: PointsSummaryResponse;
  }
>();
const pointsSummaryInflight = new Map<string, Promise<PointsSummaryResponse>>();
const referralApplyRecent = new Map<
  string,
  {
    expiresAt: number;
    value: {
      success: boolean;
      deferred?: boolean;
      message?: string;
      error?: string;
      idempotent?: boolean;
    };
  }
>();
const referralApplyInflight = new Map<
  string,
  Promise<{
    success: boolean;
    deferred?: boolean;
    message?: string;
    error?: string;
    idempotent?: boolean;
  }>
>();

function getPointsSummaryCacheKey(address: string) {
  return address.toLowerCase();
}

function getReferralApplyCacheKey(address: string, referralCode: string) {
  return `${address.toLowerCase()}:${referralCode.trim().toUpperCase()}`;
}

export function clearPointsSummaryCache(address?: string) {
  if (!address) {
    pointsSummaryCache.clear();
    pointsSummaryInflight.clear();
    return;
  }

  const key = getPointsSummaryCacheKey(address);
  pointsSummaryCache.delete(key);
  pointsSummaryInflight.delete(key);
}

export function getPointsApiUrl(path = "") {
  return buildPublicApiUrl(`/api/points${path}`);
}

export async function fetchPointsBalance(address: string) {
  const response = await publicApiFetch(getPointsApiUrl(`/${address}`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<PointsBalance>(response);
}

export async function fetchPointsSummary(
  address: string,
  options?: { force?: boolean }
) {
  const key = getPointsSummaryCacheKey(address);
  const now = Date.now();

  if (!options?.force) {
    const cached = pointsSummaryCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = pointsSummaryInflight.get(key);
    if (inflight) {
      return inflight;
    }
  }

  const request = publicApiFetch(getPointsApiUrl(`/${address}/summary`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  })
    .then((response) => parseJson<PointsSummaryResponse>(response))
    .then((data) => {
      if (data.success) {
        pointsSummaryCache.set(key, {
          expiresAt: Date.now() + POINTS_SUMMARY_TTL_MS,
          value: data,
        });
      }

      return data;
    })
    .finally(() => {
      pointsSummaryInflight.delete(key);
    });

  pointsSummaryInflight.set(key, request);
  return request;
}

export async function fetchUserStats(address: string) {
  const response = await publicApiFetch(getPointsApiUrl(`/${address}/stats`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<UserStats>(response);
}

export async function fetchReferralStats(address: string) {
  const response = await publicApiFetch(getPointsApiUrl(`/${address}/referrals`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<ReferralStats>(response);
}

export async function previewReferralCode(address: string, referralCode: string) {
  const response = await publicApiFetch(getPointsApiUrl("/referral/preview"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address, referralCode }),
  });

  return parseJson<{
    success: boolean;
    valid: boolean;
    normalizedCode?: string;
    message?: string;
    error?: string;
  }>(response);
}

export async function applyReferralCode(address: string, referralCode: string) {
  const cacheKey = getReferralApplyCacheKey(address, referralCode);
  const recent = referralApplyRecent.get(cacheKey);

  if (recent && recent.expiresAt > Date.now()) {
    return recent.value;
  }

  if (recent) {
    referralApplyRecent.delete(cacheKey);
  }

  const inflight = referralApplyInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const request = publicApiFetch(getPointsApiUrl("/referral/apply"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address, referralCode }),
  })
    .then((response) =>
      parseJson<{
        success: boolean;
        deferred?: boolean;
        message?: string;
        error?: string;
        idempotent?: boolean;
      }>(response)
    )
    .then((data) => {
      if (data.success || isTerminalReferralError(data.error)) {
        referralApplyRecent.set(cacheKey, {
          expiresAt: Date.now() + REFERRAL_APPLY_RECENT_TTL_MS,
          value: data,
        });
      }

      return data;
    })
    .finally(() => {
      referralApplyInflight.delete(cacheKey);
    });

  referralApplyInflight.set(cacheKey, request);
  return request;
}

export async function fetchLeaderboard(limit = 50) {
  const response = await publicApiFetch(getPointsApiUrl(`/leaderboard?limit=${limit}`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<LeaderboardResponse>(response);
}

export async function fetchLeaderboardHub(
  type: LeaderboardBoardType,
  options?: {
    page?: number;
    pageSize?: number;
    viewerAddress?: string;
  }
) {
  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 10;
  const viewerAddress = options?.viewerAddress;

  const searchParams = new URLSearchParams({
    type,
    page: String(page),
    pageSize: String(pageSize),
  });

  if (viewerAddress) {
    searchParams.set("viewer", viewerAddress);
  }

  const response = await publicApiFetch(getPointsApiUrl(`/leaderboards?${searchParams.toString()}`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<LeaderboardHubResponse>(response);
}

export async function performDailyCheckIn(input: {
  address: string;
  txHash: string;
  asset: "eth" | "usdc";
}) {
  const response = await publicApiFetch(getPointsApiUrl("/check-in"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<
    PointsBalance & {
      points: number;
      pointsAwarded: number;
      paymentAsset: "eth" | "usdc";
      paymentAmountUsd: number;
      unlockedBoostPercent: number;
    }
  >(response);
}

export async function resetBrokenStreak(address: string) {
  const response = await publicApiFetch(getPointsApiUrl("/check-in/reset"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
  });

  return parseJson<
    PointsBalance & {
      success: boolean;
      reset: boolean;
    }
  >(response);
}

export async function saveBrokenStreak(input: {
  address: string;
  txHash: string;
  asset: "eth" | "usdc";
}) {
  const response = await publicApiFetch(getPointsApiUrl("/check-in/save"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<
    PointsBalance & {
      success: boolean;
      restored: boolean;
      txHash: string;
      asset: "eth" | "usdc";
    }
  >(response);
}

export async function performSpin(input: { address: string; txHash: string }) {
  const response = await publicApiFetch(getPointsApiUrl("/spin"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<
    PointsBalance & {
      success: boolean;
      txHash: string;
      ticketCost: number;
      executionType: string;
      reward: SpinReward;
    }
  >(response);
}

export async function fetchSpinHistory(address: string) {
  const response = await publicApiFetch(getPointsApiUrl(`/${address}/spin-history`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<{
    success: boolean;
    history: SpinHistoryEntry[];
    error?: string;
  }>(response);
}

export type PointHistoryEntry = {
  id: number | string;
  action: string;
  label: string;
  points: number;
  createdAt: string | null;
};

export async function fetchPointHistory(address: string, limit = 50) {
  const response = await publicApiFetch(getPointsApiUrl(`/history?address=${address}&limit=${limit}`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<{
    success: boolean;
    history: PointHistoryEntry[];
    error?: string;
  }>(response);
}
