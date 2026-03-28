const DEFAULT_API_URL = "http://localhost:3001";

function normalizeApiOrigin(value: string) {
  return value.replace(/\/+$/, "").replace(/\/api$/, "");
}

function getApiOrigin() {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return normalizeApiOrigin(process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL);
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export type PointsBalance = {
  success: boolean;
  totalPoints: number;
  rank: number;
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

export function getPointsApiUrl(path = "") {
  return `${getApiOrigin()}/api/points${path}`;
}

export async function fetchPointsBalance(address: string) {
  const response = await fetch(getPointsApiUrl(`/${address}`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<PointsBalance>(response);
}

export async function fetchUserStats(address: string) {
  const response = await fetch(getPointsApiUrl(`/${address}/stats`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<UserStats>(response);
}

export async function fetchReferralStats(address: string) {
  const response = await fetch(getPointsApiUrl(`/${address}/referrals`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<ReferralStats>(response);
}

export async function fetchLeaderboard(limit = 50) {
  const response = await fetch(getPointsApiUrl(`/leaderboard?limit=${limit}`), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<LeaderboardResponse>(response);
}

export async function performDailyCheckIn(input: {
  address: string;
  txHash: string;
  asset: "eth" | "usdc";
}) {
  const response = await fetch(getPointsApiUrl("/check-in"), {
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
  const response = await fetch(getPointsApiUrl("/check-in/reset"), {
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
  const response = await fetch(getPointsApiUrl("/check-in/save"), {
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
