import type { Hex } from "viem";
import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";

const PARTNER_JOIN_STATEMENT = "DustSwap Partner Program Join";
const PARTNER_CONTENT_SUBMISSION_STATEMENT = "DustSwap Partner Content Submission";

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

export type PartnerContentSubmissionPlatform = "x" | "telegram" | "other";

export type PartnerContentSubmission = {
  id: number;
  url: string;
  platform: PartnerContentSubmissionPlatform;
  submittedAt: string;
};

export type PartnerContentSubmissionSummary = {
  total: number;
  currentMonthTotal: number;
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

export type PartnerSubmissionsResponse = {
  success: boolean;
  state: PartnerProgramState;
  summary: PartnerContentSubmissionSummary;
  rows: PartnerContentSubmission[];
  submission?: PartnerContentSubmission;
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
  submissionSummary: PartnerContentSubmissionSummary;
  submissions: PartnerContentSubmission[];
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

export type PartnerSettlePayoutResponse = {
  success: boolean;
  weekStartUtc?: string;
  paidAt?: string;
  payoutTxHash?: string;
  payoutUsdcAmount?: number;
  alreadyPaid?: boolean;
  error?: string;
};

export type PartnerBatchUpsertResponse = {
  success: boolean;
  processedCount: number;
  createdCount: number;
  updatedCount: number;
  addresses: string[];
  error?: string;
};

export type PartnerRemovePendingMembersResponse = {
  success: boolean;
  processedCount: number;
  removedCount: number;
  skippedCount: number;
  removedAddresses: string[];
  skippedAddresses: string[];
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

export function normalizePartnerContentUrl(value: string) {
  const raw = value.trim();
  if (!raw) {
    throw new Error("Paste the content link you want to submit.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid X, Telegram, or public content URL.");
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("Content links must start with http:// or https://.");
  }

  url.username = "";
  url.password = "";
  url.hash = "";
  const normalizedHostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hostname = normalizedHostname;
  const isXHost =
    normalizedHostname === "x.com" ||
    normalizedHostname === "twitter.com" ||
    normalizedHostname.endsWith(".x.com") ||
    normalizedHostname.endsWith(".twitter.com");

  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }

  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  const keptParams = Array.from(url.searchParams.entries())
    .filter(([key]) => {
      const normalizedKey = key.toLowerCase();
      return (
        !normalizedKey.startsWith("utm_") &&
        normalizedKey !== "ref" &&
        normalizedKey !== "ref_src" &&
        (!isXHost || (normalizedKey !== "s" && normalizedKey !== "t"))
      );
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      return leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue);
    });

  url.search = "";
  for (const [key, entryValue] of keptParams) {
    url.searchParams.append(key, entryValue);
  }

  return url.toString();
}

export function buildPartnerContentSubmissionMessage(address: string, url: string) {
  const domain =
    typeof window !== "undefined" ? window.location.host : "localhost:3000";
  const normalizedUrl = normalizePartnerContentUrl(url);

  return [
    PARTNER_CONTENT_SUBMISSION_STATEMENT,
    `Address: ${address}`,
    "Action: submit-partner-content",
    `URL: ${normalizedUrl}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Nonce: ${createNonce()}`,
    `Domain: ${domain}`,
  ].join("\n");
}

export async function fetchPartnerDashboard(address: string) {
  const url = new URL(getPartnerApiUrl("/dashboard"));
  url.searchParams.set("address", address);
  const response = await publicApiFetch(url.toString(), {
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
  const response = await publicApiFetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<PartnerHistoryResponse>(response);
}

export async function fetchPartnerSubmissions(address: string) {
  const url = new URL(getPartnerApiUrl("/submissions"));
  url.searchParams.set("address", address);
  const response = await publicApiFetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  return parseJson<PartnerSubmissionsResponse>(response);
}

export async function joinPartnerProgram(input: {
  address: string;
  message: string;
  signature: Hex;
}) {
  const response = await publicApiFetch(getPartnerApiUrl("/join"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return parseJson<PartnerJoinResponse>(response);
}

export async function submitPartnerContent(input: {
  address: string;
  message: string;
  signature: Hex;
  url: string;
}) {
  const normalizedUrl = normalizePartnerContentUrl(input.url);
  const response = await publicApiFetch(getPartnerApiUrl("/submissions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...input,
      url: normalizedUrl,
    }),
  });

  const data = await parseJson<PartnerSubmissionsResponse>(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Failed to submit partner content.");
  }

  return data;
}

export async function fetchPartnerAdminLeaderboard(
  adminToken: string,
  search?: string
) {
  const url = new URL(getPartnerApiUrl("/admin/leaderboard"));
  if (search?.trim()) {
    url.searchParams.set("search", search.trim());
  }

  const response = await publicApiFetch(url.toString(), {
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
  const response = await publicApiFetch(getPartnerApiUrl("/admin/members"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(input),
  });

  return parseJson<PartnerUpsertMemberResponse>(response);
}

export async function savePartnerAdminMembersBatch(
  adminToken: string,
  input: {
    addresses: string[];
    feeSharePercent: number;
    isAdmin?: boolean;
  }
) {
  const response = await publicApiFetch(getPartnerApiUrl("/admin/members/batch"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(input),
  });

  return parseJson<PartnerBatchUpsertResponse>(response);
}

export async function removePendingPartnerMembers(
  adminToken: string,
  input: {
    addresses: string[];
  }
) {
  const response = await publicApiFetch(
    getPartnerApiUrl("/admin/members/remove-pending"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify(input),
    }
  );

  return parseJson<PartnerRemovePendingMembersResponse>(response);
}

export async function fetchPartnerAdminMember(
  adminToken: string,
  address: string
) {
  const response = await publicApiFetch(
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
  const response = await publicApiFetch(getPartnerApiUrl("/admin/distributions/mark-paid"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(input),
  });

  return parseJson<PartnerMarkPaidResponse>(response);
}

export async function settlePartnerDistribution(
  adminToken: string,
  input: {
    address: string;
    weekStartUtc: string;
    payoutTxHash: string;
    paidNotes?: string | null;
  }
) {
  const response = await publicApiFetch(getPartnerApiUrl("/admin/distributions/settle"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(input),
  });

  return parseJson<PartnerSettlePayoutResponse>(response);
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
