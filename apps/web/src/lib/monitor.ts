import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";

export type MonitorWindowKey = "utc-day" | "3d" | "7d" | "30d" | "90d";

export type MonitorSummary = {
  trackedUsers: number;
  newUsers: number;
  returningUsers: number;
  registeredUsers: number;
  totalTransactions: number;
  swapTransactions: number;
  sweepTransactions: number;
  checkinTransactions: number;
  spinTransactions: number;
  swappingUsers: number;
  totalVolumeUsd: number;
  swapVolumeUsd: number;
  sweepVolumeUsd: number;
  checkinPaymentUsd: number;
  checkIns: number;
  checkInUsers: number;
  spins: number;
  spinUsers: number;
};

export type MonitorSeriesPoint = {
  date: string;
  bucketStart: string;
  bucketEnd: string;
  label: string;
  granularity: "hour" | "day";
  trackedUsers: number;
  newUsers: number;
  returningUsers: number;
  transactions: number;
  swappingUsers: number;
  volumeUsd: number;
  checkIns: number;
  spins: number;
};

export type MonitorSourceBreakdown = {
  source: string;
  transactions: number;
  users: number;
  volumeUsd: number;
};

export type MonitorUserActivity = {
  userId: number;
  address: string | null;
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  totalEvents: number;
  swapTransactions: number;
  sweepTransactions: number;
  checkIns: number;
  spins: number;
  volumeUsd: number;
};

export type MonitorTransaction = {
  kind: string;
  occurredAt: string | null;
  address: string | null;
  txHash: string | null;
  chainId: number | null;
  amountUsd: number;
  status: string | null;
};

export type MonitorCheckIn = {
  occurredAt: string | null;
  address: string | null;
  checkInDate: string | null;
  pointsEarned: number;
  streakDay: number;
  paymentTxHash: string | null;
  paymentAmountUsd: number;
};

export type MonitorSpin = {
  occurredAt: string | null;
  address: string | null;
  txHash: string | null;
  rewardLabel: string | null;
  rewardType: string | null;
  rewardAmount: number;
  rewardPoints: number;
  ticketCost: number;
  executionType: string | null;
  status: string | null;
};

export type AdminMonitorData = {
  window: {
    key: MonitorWindowKey;
    days: number;
    startAt: string;
    endAt: string;
    previousStartAt: string;
    timezone: "UTC";
  };
  current: MonitorSummary;
  previous: MonitorSummary;
  series: MonitorSeriesPoint[];
  details: {
    sourceBreakdown: MonitorSourceBreakdown[];
    userActivity: MonitorUserActivity[];
    transactions: MonitorTransaction[];
    checkIns: MonitorCheckIn[];
    spins: MonitorSpin[];
  };
  generatedAt: string;
};

function getMonitorApiUrl() {
  return buildPublicApiUrl("/api/monitor/admin");
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function fetchAdminMonitor(
  adminToken: string,
  window: MonitorWindowKey
) {
  const url = new URL(getMonitorApiUrl());
  url.searchParams.set("window", window);
  url.searchParams.set("_", String(Date.now()));

  const response = await publicApiFetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    cache: "no-store",
  });

  return parseJson<{
    success: boolean;
    data?: AdminMonitorData;
    error?: string;
  }>(response);
}
