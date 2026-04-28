import type { Hex } from "viem";
import { buildPublicApiUrl } from "@/lib/apiBase";

const PARTNER_JOIN_STATEMENT = "DustSwap Partner Program Join";

export type PartnerProgramState = "not_whitelisted" | "pending_join" | "joined";

export type PartnerMember = {
  id: number;
  userId: number;
  address: string;
  status: "whitelisted" | "joined";
  whitelistedAt: string;
  joinedAt: string | null;
  currentFeeSharePercent: number;
  isAdmin: boolean;
  referralCode: string;
  referralLink: string;
};

export type PartnerMetrics = {
  referredUsersTotal: number;
  tradedUsersTotal: number;
  qualifyingVolumeAllTimeUsd: number;
  qualifyingVolumeCurrentWeekUsd: number;
  rewardAllTimeUsd: number;
  rewardCurrentWeekUsd: number;
  latestClosedWeekStartUtc: string | null;
  latestClosedWeekRewardUsd: number;
  latestClosedWeekDueRewardUsd: number;
  unpaidRewardUsdTotal: number;
  unpaidClosedWeeks: number;
};

export type PartnerHistoryRow = {
  weekStartUtc: string;
  weekEndUtc: string;
  qualifyingVolumeUsd: number;
  protocolFeeUsd: number;
  rewardUsd: number;
  minFeeSharePercent: number | null;
  maxFeeSharePercent: number | null;
  referredUsersTotal: number;
  tradedUsersTotal: number;
  payoutUsdcAmount: number | null;
  payoutTxHash: string | null;
  paidAt: string | null;
  paidNotes: string | null;
  status: "pending" | "paid";
};

export type PartnerDashboardResponse = {
  success: boolean;
  state: PartnerProgramState;
  currentWeekStartUtc: string;
  nextDistributionAt: string;
  member: PartnerMember | null;
  metrics: PartnerMetrics;
  error?: string;
};

export type PartnerHistoryResponse = {
  success: boolean;
  state: PartnerProgramState;
  currentWeekStartUtc: string;
  rows: PartnerHistoryRow[];
  error?: string;
};

export type PartnerJoinResponse = {
  success: boolean;
  status?: "joined";
  joinedAt?: string;
  error?: string;
};

export type PartnerAdminLeaderboardRow = {
  member: PartnerMember;
  metrics: PartnerMetrics;
};

export type PartnerAdminLeaderboardResponse = {
  success: boolean;
  currentWeekStartUtc: string;
  nextDistributionAt: string;
  rows: PartnerAdminLeaderboardRow[];
  error?: string;
};

export type PartnerReferredUserRow = {
  refereeUserId: number;
  address: string;
  referralActivatedAt: string;
  hasQualifiedTrade: boolean;
  qualifyingVolumeAllTimeUsd: number;
  qualifyingVolumeCurrentWeekUsd: number;
  rewardAllTimeUsd: number;
  rewardCurrentWeekUsd: number;
  firstQualifyingTradeAt: string | null;
  lastQualifyingTradeAt: string | null;
};

export type PartnerAdminMemberDetailResponse = {
  success: boolean;
  currentWeekStartUtc: string;
  nextDistributionAt: string;
  member: PartnerMember;
  metrics: PartnerMetrics;
  history: PartnerHistoryRow[];
  referredUsers: PartnerReferredUserRow[];
  error?: string;
};

export type PartnerUpsertMemberResponse = PartnerAdminMemberDetailResponse;

export type PartnerMarkPaidResponse = {
  success: boolean;
  weekStartUtc?: string;
  paidAt?: string;
  error?: string;
};

function parseJson<T>(response: Response): Promise<T> {
  return response.text().then((text) => (text ? JSON.parse(text) : {}));
}

function createNonce() {
  const browserCrypto =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;

  if (browserCrypto?.randomUUID) {
    return browserCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (browserCrypto?.getRandomValues) {
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getPartnerApiUrl(path = "") {
  const normalizedPath = path
    ? path.startsWith("/")
      ? path
      : `/${path}`
    : "";

  return buildPublicApiUrl(`/api/partner${normalizedPath}`);
}

export function buildPartnerJoinMessage(address: string) {
  const domain =
    typeof window !== "undefined" ? window.location.host : "localhost:3000";

  return [
    PARTNER_JOIN_STATEMENT,
    `Address: ${address}`,
    "Action: join-partner-program",
    `Timestamp: ${new Date().toISOString()}`,
    `Nonce: ${createNonce()}`,
    `Domain: ${domain}`,
  ].join("\n");
}

export async function fetchPartnerDashboard(address: string) {
  const url = new URL(getPartnerApiUrl("/dashboard"));
  url.searchParams.set("address", address);
  const response = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<PartnerDashboardResponse>(response);
}

export async function fetchPartnerHistory(address: string) {
  const url = new URL(getPartnerApiUrl("/history"));
  url.searchParams.set("address", address);
  const response = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<PartnerHistoryResponse>(response);
}

export async function joinPartnerProgram(input: {
  address: string;
  message: string;
  signature: Hex;
}) {
  const response = await fetch(getPartnerApiUrl("/join"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<PartnerJoinResponse>(response);
}

export async function fetchPartnerAdminLeaderboard(
  adminToken: string,
  search?: string
) {
  const url = new URL(getPartnerApiUrl("/admin/leaderboard"));
  if (search?.trim()) {
    url.searchParams.set("search", search.trim());
  }

  const response = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    cache: "no-store",
  });

  return parseJson<PartnerAdminLeaderboardResponse>(response);
}

export async function savePartnerAdminMember(
  adminToken: string,
  input: {
    address: string;
    feeSharePercent: number;
    isAdmin?: boolean;
  }
) {
  const response = await fetch(getPartnerApiUrl("/admin/members"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(input),
  });

  return parseJson<PartnerUpsertMemberResponse>(response);
}

export async function fetchPartnerAdminMember(
  adminToken: string,
  address: string
) {
  const response = await fetch(
    getPartnerApiUrl(`/admin/members/${encodeURIComponent(address)}`),
    {
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      cache: "no-store",
    }
  );

  return parseJson<PartnerAdminMemberDetailResponse>(response);
}

export async function markPartnerDistributionPaid(
  adminToken: string,
  input: {
    address: string;
    weekStartUtc: string;
    payoutUsdcAmount: number;
    payoutTxHash: string;
    paidNotes?: string | null;
  }
) {
  const response = await fetch(getPartnerApiUrl("/admin/distributions/mark-paid"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(input),
  });

  return parseJson<PartnerMarkPaidResponse>(response);
}

export function shortAddress(address?: string | null) {
  if (!address) {
    return "Wallet";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatUsd(value: number) {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

export function formatUsdc(value: number | null | undefined) {
  if (value == null) {
    return "--";
  }

  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDC`;
}

export function formatFeeShareRange(
  minFeeSharePercent: number | null,
  maxFeeSharePercent: number | null
) {
  if (minFeeSharePercent == null && maxFeeSharePercent == null) {
    return "--";
  }

  if (minFeeSharePercent == null || maxFeeSharePercent == null) {
    return `${(minFeeSharePercent ?? maxFeeSharePercent ?? 0).toFixed(2)}%`;
  }

  if (Math.abs(minFeeSharePercent - maxFeeSharePercent) < 0.001) {
    return `${minFeeSharePercent.toFixed(2)}%`;
  }

  return `${minFeeSharePercent.toFixed(2)}%-${maxFeeSharePercent.toFixed(2)}%`;
}

export function getDistributionCountdown(targetIso: string) {
  const targetTime = new Date(targetIso).getTime();
  const remainingMs = Math.max(0, targetTime - Date.now());
  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return {
    remainingMs,
    days,
    hours,
    minutes,
    seconds,
    expired: remainingMs <= 0,
  };
}

export function formatUtcDate(value?: string | null) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export function formatWeekLabel(weekStartUtc: string, weekEndUtc: string) {
  const start = new Date(`${weekStartUtc}T00:00:00.000Z`);
  const end = new Date(`${weekEndUtc}T00:00:00.000Z`);

  return `${start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })} - ${end.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })}`;
}
