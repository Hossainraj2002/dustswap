import { createHash } from "crypto";
import { getAddress, isAddress, type Hex } from "viem";
import { isAllowedAppDomain } from "../config/appOrigins";
import { runtimeCache } from "../utils/runtimeCache";
import { createBasePublicClient } from "../utils/baseRpc";
import { pointsEngine } from "./pointsEngine";
import { postgresDb } from "./postgres";
import { isConnectedXAccount, type XSocialAccountRecord } from "./xVerification";

const PARTNER_JOIN_STATEMENT = "DustSwap Partner Program Join";
const PARTNER_CONTENT_SUBMISSION_STATEMENT = "DustSwap Partner Content Submission";
const PARTNER_JOIN_SIGNATURE_TTL_MS = 5 * 60 * 1000;
const PARTNER_JOIN_FUTURE_SKEW_MS = 60 * 1000;
const PARTNER_JOIN_WINDOW_MS = 60 * 1000;
const PARTNER_JOIN_LIMIT = 8;
const PARTNER_CONTENT_SUBMISSION_SIGNATURE_TTL_MS = 5 * 60 * 1000;
const PARTNER_CONTENT_SUBMISSION_FUTURE_SKEW_MS = 60 * 1000;
const PARTNER_CONTENT_SUBMISSION_WINDOW_MS = 60 * 1000;
const PARTNER_CONTENT_SUBMISSION_LIMIT = 12;
const PARTNER_PROTOCOL_FEE_RATE = 0.002;

const publicClient = createBasePublicClient();

type PartnerProgramState = "not_whitelisted" | "pending_join" | "joined";

type UserRow = {
  id: number;
  address: string;
  referral_code: string;
};

type MemberRow = {
  id: number | string;
  user_id: number | string;
  wallet_address: string;
  status: string;
  whitelisted_at: string;
  joined_at: string | null;
  current_fee_share_percent: number | string | null;
  is_admin: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type ReferralCountRow = {
  partner_member_id: number | string;
  partner_user_id: number | string;
  partner_wallet_address: string;
  referred_users_total: number | string | null;
};

type AlltimeMetricRow = {
  partner_member_id: number | string;
  partner_user_id: number | string;
  partner_wallet_address: string;
  traded_users_total: number | string | null;
  swap_count_total: number | string | null;
  qualifying_volume_all_time_usd: number | string | null;
  protocol_fee_all_time_usd: number | string | null;
  reward_all_time_usd: number | string | null;
  first_qualifying_trade_at: string | null;
  last_qualifying_trade_at: string | null;
};

type WeeklyMetricRow = {
  partner_member_id: number | string;
  partner_user_id: number | string;
  partner_wallet_address: string;
  week_start_utc: string | Date;
  traded_users_total: number | string | null;
  swap_count_total: number | string | null;
  qualifying_volume_usd: number | string | null;
  protocol_fee_usd: number | string | null;
  reward_usd: number | string | null;
  min_fee_share_percent: number | string | null;
  max_fee_share_percent: number | string | null;
  first_trade_at: string | null;
  last_trade_at: string | null;
};

type DistributionRow = {
  id: number | string;
  partner_member_id: number | string;
  week_start_utc: string | Date;
  week_end_utc: string | Date;
  qualifying_volume_usd: number | string | null;
  protocol_fee_usd: number | string | null;
  reward_usd: number | string | null;
  min_fee_share_percent: number | string | null;
  max_fee_share_percent: number | string | null;
  referred_users_total: number | string | null;
  traded_users_total: number | string | null;
  payout_usdc_amount: number | string | null;
  payout_tx_hash: string | null;
  paid_at: string | null;
  paid_notes: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type ReferredUserRow = {
  partner_member_id: number | string;
  partner_user_id: number | string;
  partner_wallet_address: string;
  partner_status: string;
  whitelisted_at: string;
  joined_at: string | null;
  current_fee_share_percent: number | string | null;
  referee_user_id: number | string;
  referee_address: string;
  referral_activated_at: string;
};

type ReferredUserAlltimeMetricRow = {
  partner_member_id: number | string;
  partner_user_id: number | string;
  referee_user_id: number | string;
  referee_address: string;
  referral_activated_at: string | null;
  swap_count_total: number | string | null;
  qualifying_volume_all_time_usd: number | string | null;
  reward_all_time_usd: number | string | null;
  first_qualifying_trade_at: string | null;
  last_qualifying_trade_at: string | null;
};

type ReferredUserWeeklyMetricRow = {
  partner_member_id: number | string;
  partner_user_id: number | string;
  referee_user_id: number | string;
  referee_address: string;
  week_start_utc: string | Date;
  swap_count_total: number | string | null;
  qualifying_volume_usd: number | string | null;
  reward_usd: number | string | null;
  min_fee_share_percent: number | string | null;
  max_fee_share_percent: number | string | null;
  first_trade_at: string | null;
  last_trade_at: string | null;
};

type PartnerJoinInput = {
  address?: string;
  message?: string;
  signature?: Hex;
};

type PartnerContentSubmissionInput = {
  address?: string;
  message?: string;
  signature?: Hex;
  url?: string;
};

type PartnerMemberPayload = {
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

type PartnerMetricsPayload = {
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

type PartnerHistoryRowPayload = {
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

type PartnerContentSubmissionRow = {
  id: number | string;
  partner_member_id: number | string;
  partner_user_id: number | string;
  content_url: string;
  normalized_url: string;
  platform: string;
  submitted_at: string;
  created_at?: string | null;
};

type PartnerContentSubmissionPayload = {
  id: number;
  url: string;
  platform: "x" | "telegram" | "other";
  submittedAt: string;
};

type PartnerContentSubmissionSummaryPayload = {
  total: number;
  currentMonthTotal: number;
};

export class PartnerProgramError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function firstRow<T>(rows: T[] | null | undefined) {
  return rows?.[0] ?? null;
}

function toNumber(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function normalizeDateOnlyValue(value: string | Date | null | undefined) {
  if (!value) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString().slice(0, 10);
  }
  const normalized = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const numericValue = Number(normalized);
  if (normalized.length >= 8 && Number.isFinite(numericValue)) {
    // If it's less than 10 billion, it's likely epoch seconds, not milliseconds
    const msValue = numericValue < 10000000000 ? numericValue * 1000 : numericValue;
    const dNum = new Date(msValue);
    if (!Number.isNaN(dNum.getTime())) {
      return dNum.toISOString().slice(0, 10);
    }
  }

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return "";
}

function addUtcDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateKey(date);
}

function getCurrentUtcWeekStart(reference = new Date()) {
  const date = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate()
    )
  );
  const delta = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - delta);
  return date;
}

function getNextUtcWeekStart(reference = new Date()) {
  const start = getCurrentUtcWeekStart(reference);
  start.setUTCDate(start.getUTCDate() + 7);
  return start;
}

function parsePartnerJoinMessage(message: string) {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== PARTNER_JOIN_STATEMENT) {
    throw new PartnerProgramError("Invalid partner join message.", 401);
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    fields.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim()
    );
  }

  return {
    address: fields.get("address") || "",
    action: fields.get("action") || "",
    timestamp: fields.get("timestamp") || "",
    nonce: fields.get("nonce") || "",
    domain: fields.get("domain") || "",
  };
}

function parsePartnerContentSubmissionMessage(message: string) {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== PARTNER_CONTENT_SUBMISSION_STATEMENT) {
    throw new PartnerProgramError("Invalid partner content submission message.", 401);
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    fields.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim()
    );
  }

  return {
    address: fields.get("address") || "",
    action: fields.get("action") || "",
    url: fields.get("url") || "",
    timestamp: fields.get("timestamp") || "",
    nonce: fields.get("nonce") || "",
    domain: fields.get("domain") || "",
  };
}

function normalizeAddress(address: string) {
  if (!isAddress(address)) {
    throw new PartnerProgramError("A valid wallet address is required.", 400);
  }

  return getAddress(address).toLowerCase();
}

function normalizeFeeSharePercent(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new PartnerProgramError("Fee share percent must be between 0 and 100.", 400);
  }

  return Math.round(parsed * 100) / 100;
}

function normalizeWeekStartDate(value: unknown) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new PartnerProgramError("weekStartUtc must use YYYY-MM-DD.", 400);
  }

  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new PartnerProgramError("weekStartUtc must use YYYY-MM-DD.", 400);
  }

  return normalized;
}

function normalizeTxHash(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(normalized)) {
    throw new PartnerProgramError("A valid payout tx hash is required.", 400);
  }

  return normalized;
}

function normalizePartnerContentUrl(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new PartnerProgramError("A valid content link is required.", 400);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PartnerProgramError("A valid content link is required.", 400);
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new PartnerProgramError("Content links must start with http:// or https://.", 400);
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

function detectPartnerContentPlatform(
  normalizedUrl: string
): PartnerContentSubmissionPayload["platform"] {
  let hostname = "";
  try {
    hostname = new URL(normalizedUrl).hostname.toLowerCase();
  } catch {
    return "other";
  }

  if (
    hostname === "x.com" ||
    hostname === "twitter.com" ||
    hostname.endsWith(".x.com") ||
    hostname.endsWith(".twitter.com")
  ) {
    return "x";
  }

  if (
    hostname === "t.me" ||
    hostname === "telegram.me" ||
    hostname.endsWith(".t.me")
  ) {
    return "telegram";
  }

  return "other";
}

function getCurrentUtcMonthStartIso(reference = new Date()) {
  return new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1)
  ).toISOString();
}

function buildReferralLink(code: string) {
  const baseUrl =
    (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://app.dustswap.wtf")
      .trim()
      .replace(/\/+$/, "");
  return `${baseUrl}/?ref=${encodeURIComponent(code.trim().toUpperCase())}`;
}

function buildMemberState(member: MemberRow | null): PartnerProgramState {
  if (!member) {
    return "not_whitelisted";
  }

  return member.joined_at ? "joined" : "pending_join";
}

function buildMetricsPayload(input?: {
  referredUsersTotal?: number;
  tradedUsersTotal?: number;
  qualifyingVolumeAllTimeUsd?: number;
  qualifyingVolumeCurrentWeekUsd?: number;
  rewardAllTimeUsd?: number;
  rewardCurrentWeekUsd?: number;
  latestClosedWeekStartUtc?: string | null;
  latestClosedWeekRewardUsd?: number;
  latestClosedWeekDueRewardUsd?: number;
  unpaidRewardUsdTotal?: number;
  unpaidClosedWeeks?: number;
}): PartnerMetricsPayload {
  return {
    referredUsersTotal: input?.referredUsersTotal ?? 0,
    tradedUsersTotal: input?.tradedUsersTotal ?? 0,
    qualifyingVolumeAllTimeUsd: input?.qualifyingVolumeAllTimeUsd ?? 0,
    qualifyingVolumeCurrentWeekUsd: input?.qualifyingVolumeCurrentWeekUsd ?? 0,
    rewardAllTimeUsd: input?.rewardAllTimeUsd ?? 0,
    rewardCurrentWeekUsd: input?.rewardCurrentWeekUsd ?? 0,
    latestClosedWeekStartUtc: input?.latestClosedWeekStartUtc ?? null,
    latestClosedWeekRewardUsd: input?.latestClosedWeekRewardUsd ?? 0,
    latestClosedWeekDueRewardUsd: input?.latestClosedWeekDueRewardUsd ?? 0,
    unpaidRewardUsdTotal: input?.unpaidRewardUsdTotal ?? 0,
    unpaidClosedWeeks: input?.unpaidClosedWeeks ?? 0,
  };
}

function weekComparatorDescending(a: { weekStartUtc: string }, b: { weekStartUtc: string }) {
  return b.weekStartUtc.localeCompare(a.weekStartUtc);
}

export class PartnerProgramService {
  private async loadUserById(userId: number) {
    const { data, error } = await postgresDb
      .from("users")
      .select("id, address, referral_code")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      throw new Error(`Load partner user: ${error.message}`);
    }

    return (data as UserRow | null) ?? null;
  }

  private async loadUsersByIds(userIds: number[]) {
    if (!userIds.length) {
      return new Map<number, UserRow>();
    }

    const { data, error } = await postgresDb
      .from("users")
      .select("id, address, referral_code")
      .in("id", userIds);

    if (error) {
      throw new Error(`Load partner users: ${error.message}`);
    }

    const users = new Map<number, UserRow>();
    for (const row of (data ?? []) as UserRow[]) {
      users.set(Number(row.id), {
        id: Number(row.id),
        address: String(row.address),
        referral_code: String(row.referral_code || ""),
      });
    }

    return users;
  }

  private async findMemberByAddress(address: string) {
    const normalizedAddress = normalizeAddress(address);
    const { data, error } = await postgresDb
      .from("partner_program_members")
      .select("*")
      .eq("wallet_address", normalizedAddress)
      .maybeSingle();

    if (error) {
      throw new Error(`Load partner member: ${error.message}`);
    }

    return (data as MemberRow | null) ?? null;
  }

  private async loadAllMembers() {
    const { data, error } = await postgresDb
      .from("partner_program_members")
      .select("*")
      .order("whitelisted_at", { ascending: false });

    if (error) {
      throw new Error(`Load partner members: ${error.message}`);
    }

    return (data ?? []) as MemberRow[];
  }

  private async loadReferralCounts(memberIds: number[]) {
    if (!memberIds.length) {
      return new Map<number, ReferralCountRow>();
    }

    const { data, error } = await postgresDb
      .from("partner_program_member_referral_counts")
      .select("*")
      .in("partner_member_id", memberIds);

    if (error) {
      throw new Error(`Load partner referral counts: ${error.message}`);
    }

    const rows = new Map<number, ReferralCountRow>();
    for (const row of (data ?? []) as ReferralCountRow[]) {
      rows.set(Number(row.partner_member_id), row);
    }
    return rows;
  }

  private async loadAlltimeMetrics(memberIds: number[]) {
    if (!memberIds.length) {
      return new Map<number, AlltimeMetricRow>();
    }

    const { data, error } = await postgresDb
      .from("partner_program_member_alltime_metrics")
      .select("*")
      .in("partner_member_id", memberIds);

    if (error) {
      throw new Error(`Load partner all-time metrics: ${error.message}`);
    }

    const rows = new Map<number, AlltimeMetricRow>();
    for (const row of (data ?? []) as AlltimeMetricRow[]) {
      rows.set(Number(row.partner_member_id), row);
    }
    return rows;
  }

  private async loadWeeklyMetrics(memberIds: number[], options?: { beforeWeekStart?: string }) {
    if (!memberIds.length) {
      return [] as WeeklyMetricRow[];
    }

    let query = postgresDb
      .from("partner_program_member_weekly_metrics")
      .select("*")
      .in("partner_member_id", memberIds);

    if (options?.beforeWeekStart) {
      query = query.lt("week_start_utc", options.beforeWeekStart);
    }

    const { data, error } = await query.order("week_start_utc", { ascending: false });

    if (error) {
      throw new Error(`Load partner weekly metrics: ${error.message}`);
    }

    return ((data ?? []) as WeeklyMetricRow[]).map((row) => ({
      ...row,
      week_start_utc: normalizeDateOnlyValue(row.week_start_utc),
    }));
  }

  private async loadDistributions(memberIds: number[]) {
    if (!memberIds.length) {
      return [] as DistributionRow[];
    }

    const { data, error } = await postgresDb
      .from("partner_reward_distributions")
      .select("*")
      .in("partner_member_id", memberIds)
      .order("week_start_utc", { ascending: false });

    if (error) {
      throw new Error(`Load partner distributions: ${error.message}`);
    }

    return ((data ?? []) as DistributionRow[]).map((row) => ({
      ...row,
      week_start_utc: normalizeDateOnlyValue(row.week_start_utc),
      week_end_utc: normalizeDateOnlyValue(row.week_end_utc),
    }));
  }

  private async loadReferredUsers(memberId: number) {
    const { data, error } = await postgresDb
      .from("partner_program_referred_users")
      .select("*")
      .eq("partner_member_id", memberId)
      .order("referral_activated_at", { ascending: false });

    if (error) {
      throw new Error(`Load referred users: ${error.message}`);
    }

    return (data ?? []) as ReferredUserRow[];
  }

  private async loadReferredUserAlltimeMetrics(memberId: number) {
    const { data, error } = await postgresDb
      .from("partner_program_referred_user_alltime_metrics")
      .select("*")
      .eq("partner_member_id", memberId);

    if (error) {
      throw new Error(`Load referred user all-time metrics: ${error.message}`);
    }

    const rows = new Map<number, ReferredUserAlltimeMetricRow>();
    for (const row of (data ?? []) as ReferredUserAlltimeMetricRow[]) {
      rows.set(Number(row.referee_user_id), row);
    }

    return rows;
  }

  private async loadReferredUserWeeklyMetrics(memberId: number, weekStartUtc: string) {
    const { data, error } = await postgresDb
      .from("partner_program_referred_user_weekly_metrics")
      .select("*")
      .eq("partner_member_id", memberId)
      .eq("week_start_utc", weekStartUtc);

    if (error) {
      throw new Error(`Load referred user weekly metrics: ${error.message}`);
    }

    const rows = new Map<number, ReferredUserWeeklyMetricRow>();
    for (const row of (data ?? []) as ReferredUserWeeklyMetricRow[]) {
      rows.set(Number(row.referee_user_id), {
        ...row,
        week_start_utc: normalizeDateOnlyValue(row.week_start_utc),
      });
    }

    return rows;
  }

  private async loadConnectedXAccount(userId: number) {
    const { data, error } = await postgresDb
      .from("social_accounts")
      .select(
        "id, user_id, platform, platform_user_id, username, display_name, profile_image_url, metadata, created_at, updated_at"
      )
      .eq("user_id", userId)
      .eq("platform", "x")
      .maybeSingle();

    if (error) {
      throw new Error(`Load partner X account: ${error.message}`);
    }

    const account = (data as XSocialAccountRecord | null) ?? null;
    return account && isConnectedXAccount(account) ? account : null;
  }

  private async loadContentSubmissions(memberId: number) {
    const { data, error } = await postgresDb
      .from("partner_content_submissions")
      .select("*")
      .eq("partner_member_id", memberId)
      .order("submitted_at", { ascending: false });

    if (error) {
      throw new Error(`Load partner content submissions: ${error.message}`);
    }

    return (data ?? []) as PartnerContentSubmissionRow[];
  }

  private buildMemberPayload(member: MemberRow, user: UserRow): PartnerMemberPayload {
    return {
      id: Number(member.id),
      userId: Number(member.user_id),
      address: normalizeAddress(member.wallet_address),
      status: member.joined_at ? "joined" : "whitelisted",
      whitelistedAt: member.whitelisted_at,
      joinedAt: member.joined_at,
      currentFeeSharePercent: toNumber(member.current_fee_share_percent),
      isAdmin: Boolean(member.is_admin),
      referralCode: user.referral_code,
      referralLink: buildReferralLink(user.referral_code),
    };
  }

  private buildContentSubmissionPayload(
    row: PartnerContentSubmissionRow
  ): PartnerContentSubmissionPayload {
    const platform = detectPartnerContentPlatform(row.normalized_url || row.content_url);

    return {
      id: Number(row.id),
      url: row.content_url,
      platform,
      submittedAt: row.submitted_at,
    };
  }

  private buildContentSubmissionSummary(
    rows: PartnerContentSubmissionPayload[]
  ): PartnerContentSubmissionSummaryPayload {
    const monthStartIso = getCurrentUtcMonthStartIso();
    const currentMonthTotal = rows.filter((row) => row.submittedAt >= monthStartIso).length;

    return {
      total: rows.length,
      currentMonthTotal,
    };
  }

  private buildMemberMetrics(options: {
    memberId: number;
    referralCounts: Map<number, ReferralCountRow>;
    alltimeMetrics: Map<number, AlltimeMetricRow>;
    currentWeekMetrics: Map<number, WeeklyMetricRow>;
    closedWeeklyMetrics: Map<number, WeeklyMetricRow[]>;
    distributionsByMember: Map<number, Map<string, DistributionRow>>;
  }) {
    const referredUsersTotal = toNumber(
      options.referralCounts.get(options.memberId)?.referred_users_total
    );
    const alltime = options.alltimeMetrics.get(options.memberId);
    const currentWeek = options.currentWeekMetrics.get(options.memberId);
    const closedWeekly = options.closedWeeklyMetrics.get(options.memberId) ?? [];
    const distributions = options.distributionsByMember.get(options.memberId) ?? new Map();

    let latestClosedWeekStartUtc: string | null = null;
    let latestClosedWeekRewardUsd = 0;
    let latestClosedWeekDueRewardUsd = 0;
    let unpaidRewardUsdTotal = 0;
    let unpaidClosedWeeks = 0;

    for (const weekly of closedWeekly) {
      const weekStartUtc = normalizeDateOnlyValue(weekly.week_start_utc);
      const rewardUsd = toNumber(weekly.reward_usd);
      const distribution = distributions.get(weekStartUtc);

      if (!latestClosedWeekStartUtc) {
        latestClosedWeekStartUtc = weekStartUtc;
        latestClosedWeekRewardUsd = rewardUsd;
        latestClosedWeekDueRewardUsd = distribution?.paid_at ? 0 : rewardUsd;
      }

      if (!distribution?.paid_at) {
        unpaidRewardUsdTotal += rewardUsd;
        unpaidClosedWeeks += 1;
      }
    }

    return buildMetricsPayload({
      referredUsersTotal,
      tradedUsersTotal: toNumber(alltime?.traded_users_total),
      qualifyingVolumeAllTimeUsd: toNumber(alltime?.qualifying_volume_all_time_usd),
      qualifyingVolumeCurrentWeekUsd: toNumber(currentWeek?.qualifying_volume_usd),
      rewardAllTimeUsd: toNumber(alltime?.reward_all_time_usd),
      rewardCurrentWeekUsd: toNumber(currentWeek?.reward_usd),
      latestClosedWeekStartUtc,
      latestClosedWeekRewardUsd,
      latestClosedWeekDueRewardUsd,
      unpaidRewardUsdTotal,
      unpaidClosedWeeks,
    });
  }

  private buildHistoryRowsForMember(options: {
    memberId: number;
    referredUsersTotal: number;
    closedWeeklyMetrics: WeeklyMetricRow[];
    distributionsByWeekStart: Map<string, DistributionRow>;
  }) {
    return options.closedWeeklyMetrics
      .map<PartnerHistoryRowPayload>((weekly) => {
        const weekStartUtc = normalizeDateOnlyValue(weekly.week_start_utc);
        const distribution = options.distributionsByWeekStart.get(weekStartUtc);
        return {
          weekStartUtc,
          weekEndUtc: distribution?.week_end_utc
            ? normalizeDateOnlyValue(distribution.week_end_utc)
            : addUtcDays(weekStartUtc, 7),
          qualifyingVolumeUsd:
            distribution?.qualifying_volume_usd != null
              ? toNumber(distribution.qualifying_volume_usd)
              : toNumber(weekly.qualifying_volume_usd),
          protocolFeeUsd:
            distribution?.protocol_fee_usd != null
              ? toNumber(distribution.protocol_fee_usd)
              : toNumber(weekly.protocol_fee_usd),
          rewardUsd:
            distribution?.reward_usd != null
              ? toNumber(distribution.reward_usd)
              : toNumber(weekly.reward_usd),
          minFeeSharePercent:
            distribution?.min_fee_share_percent != null
              ? toNumber(distribution.min_fee_share_percent)
              : weekly.min_fee_share_percent != null
                ? toNumber(weekly.min_fee_share_percent)
                : null,
          maxFeeSharePercent:
            distribution?.max_fee_share_percent != null
              ? toNumber(distribution.max_fee_share_percent)
              : weekly.max_fee_share_percent != null
                ? toNumber(weekly.max_fee_share_percent)
                : null,
          referredUsersTotal:
            distribution?.referred_users_total != null
              ? toNumber(distribution.referred_users_total)
              : options.referredUsersTotal,
          tradedUsersTotal:
            distribution?.traded_users_total != null
              ? toNumber(distribution.traded_users_total)
              : toNumber(weekly.traded_users_total),
          payoutUsdcAmount:
            distribution?.payout_usdc_amount != null
              ? toNumber(distribution.payout_usdc_amount)
              : null,
          payoutTxHash: distribution?.payout_tx_hash || null,
          paidAt: distribution?.paid_at || null,
          paidNotes: distribution?.paid_notes || null,
          status: distribution?.paid_at ? "paid" : "pending",
        };
      })
      .sort(weekComparatorDescending);
  }

  private async buildMemberContext(member: MemberRow) {
    const memberId = Number(member.id);
    const userId = Number(member.user_id);
    const currentWeekStartUtc = toDateKey(getCurrentUtcWeekStart());

    const [user, referralCounts, alltimeMetrics, currentWeekRows, closedWeeklyRows, distributions] =
      await Promise.all([
        this.loadUserById(userId),
        this.loadReferralCounts([memberId]),
        this.loadAlltimeMetrics([memberId]),
        this.loadWeeklyMetrics([memberId]),
        this.loadWeeklyMetrics([memberId], { beforeWeekStart: currentWeekStartUtc }),
        this.loadDistributions([memberId]),
      ]);

    if (!user) {
      throw new Error("Partner member is missing its linked user.");
    }

    const currentWeekMetrics = new Map<number, WeeklyMetricRow>();
    for (const row of currentWeekRows) {
      if (normalizeDateOnlyValue(row.week_start_utc) === currentWeekStartUtc) {
        currentWeekMetrics.set(Number(row.partner_member_id), row);
      }
    }

    const closedWeeklyMetrics = new Map<number, WeeklyMetricRow[]>();
    for (const row of closedWeeklyRows) {
      const key = Number(row.partner_member_id);
      const list = closedWeeklyMetrics.get(key) ?? [];
      list.push(row);
      closedWeeklyMetrics.set(key, list);
    }

    const distributionsByMember = new Map<number, Map<string, DistributionRow>>();
    for (const row of distributions) {
      const key = Number(row.partner_member_id);
      const list = distributionsByMember.get(key) ?? new Map<string, DistributionRow>();
      list.set(normalizeDateOnlyValue(row.week_start_utc), row);
      distributionsByMember.set(key, list);
    }

    const referredUsersTotal = toNumber(referralCounts.get(memberId)?.referred_users_total);

    return {
      user,
      currentWeekStartUtc,
      memberPayload: this.buildMemberPayload(member, user),
      metrics: this.buildMemberMetrics({
        memberId,
        referralCounts,
        alltimeMetrics,
        currentWeekMetrics,
        closedWeeklyMetrics,
        distributionsByMember,
      }),
      history: this.buildHistoryRowsForMember({
        memberId,
        referredUsersTotal,
        closedWeeklyMetrics: closedWeeklyMetrics.get(memberId) ?? [],
        distributionsByWeekStart: distributionsByMember.get(memberId) ?? new Map(),
      }),
    };
  }

  private async assertJoinAuthentication(input: PartnerJoinInput, requestIp: string) {
    if (!input.address || !input.message || !input.signature) {
      throw new PartnerProgramError("address, message, and signature are required.", 400);
    }

    const normalizedAddress = normalizeAddress(input.address);
    const parsed = parsePartnerJoinMessage(input.message);
    const messageAddress = normalizeAddress(parsed.address);

    if (messageAddress !== normalizedAddress) {
      throw new PartnerProgramError("Partner signature address mismatch.", 401);
    }

    if (parsed.action !== "join-partner-program") {
      throw new PartnerProgramError("Invalid partner join action.", 401);
    }

    if (!parsed.domain || !isAllowedAppDomain(parsed.domain)) {
      throw new PartnerProgramError("Unexpected partner join domain.", 401);
    }

    if (!parsed.nonce || parsed.nonce.length < 8 || parsed.nonce.length > 128) {
      throw new PartnerProgramError("Invalid partner join nonce.", 401);
    }

    const timestampMs = Date.parse(parsed.timestamp);
    const now = Date.now();
    if (!Number.isFinite(timestampMs)) {
      throw new PartnerProgramError("Invalid partner join timestamp.", 401);
    }

    if (now - timestampMs > PARTNER_JOIN_SIGNATURE_TTL_MS) {
      throw new PartnerProgramError("Expired partner join signature.", 401);
    }

    if (timestampMs - now > PARTNER_JOIN_FUTURE_SKEW_MS) {
      throw new PartnerProgramError("Invalid partner join timestamp.", 401);
    }

    const rateLimit = runtimeCache.consumeRateLimit(
      `partner-join:rate:${normalizedAddress}:${requestIp}`,
      PARTNER_JOIN_LIMIT,
      PARTNER_JOIN_WINDOW_MS
    );

    if (!rateLimit.allowed) {
      throw new PartnerProgramError("Partner join is cooling down. Please wait.", 429);
    }

    const replayKey = `partner-join:replay:${createHash("sha256")
      .update(`${input.message}|${input.signature.toLowerCase()}`)
      .digest("hex")}`;

    if (runtimeCache.get(replayKey)) {
      throw new PartnerProgramError("Partner join signature was already used.", 401);
    }

    const valid = await publicClient.verifyMessage({
      address: normalizedAddress as `0x${string}`,
      message: input.message,
      signature: input.signature,
    });

    if (!valid) {
      throw new PartnerProgramError("Invalid partner join signature.", 401);
    }

    runtimeCache.set(replayKey, true, PARTNER_JOIN_SIGNATURE_TTL_MS);
    return normalizedAddress;
  }

  private async assertContentSubmissionAuthentication(
    input: PartnerContentSubmissionInput,
    requestIp: string
  ) {
    if (!input.address || !input.message || !input.signature || !input.url) {
      throw new PartnerProgramError(
        "address, message, signature, and url are required.",
        400
      );
    }

    const normalizedAddress = normalizeAddress(input.address);
    const normalizedUrl = normalizePartnerContentUrl(input.url);
    const parsed = parsePartnerContentSubmissionMessage(input.message);
    const messageAddress = normalizeAddress(parsed.address);
    const messageUrl = normalizePartnerContentUrl(parsed.url);

    if (messageAddress !== normalizedAddress) {
      throw new PartnerProgramError("Partner content signature address mismatch.", 401);
    }

    if (messageUrl !== normalizedUrl) {
      throw new PartnerProgramError("Partner content signature URL mismatch.", 401);
    }

    if (parsed.action !== "submit-partner-content") {
      throw new PartnerProgramError("Invalid partner content action.", 401);
    }

    if (!parsed.domain || !isAllowedAppDomain(parsed.domain)) {
      throw new PartnerProgramError("Unexpected partner content domain.", 401);
    }

    if (!parsed.nonce || parsed.nonce.length < 8 || parsed.nonce.length > 128) {
      throw new PartnerProgramError("Invalid partner content nonce.", 401);
    }

    const timestampMs = Date.parse(parsed.timestamp);
    const now = Date.now();
    if (!Number.isFinite(timestampMs)) {
      throw new PartnerProgramError("Invalid partner content timestamp.", 401);
    }

    if (now - timestampMs > PARTNER_CONTENT_SUBMISSION_SIGNATURE_TTL_MS) {
      throw new PartnerProgramError("Expired partner content signature.", 401);
    }

    if (timestampMs - now > PARTNER_CONTENT_SUBMISSION_FUTURE_SKEW_MS) {
      throw new PartnerProgramError("Invalid partner content timestamp.", 401);
    }

    const rateLimit = runtimeCache.consumeRateLimit(
      `partner-content-submit:rate:${normalizedAddress}:${requestIp}`,
      PARTNER_CONTENT_SUBMISSION_LIMIT,
      PARTNER_CONTENT_SUBMISSION_WINDOW_MS
    );

    if (!rateLimit.allowed) {
      throw new PartnerProgramError("Content submission is cooling down. Please wait.", 429);
    }

    const replayKey = `partner-content-submit:replay:${createHash("sha256")
      .update(`${input.message}|${input.signature.toLowerCase()}`)
      .digest("hex")}`;

    if (runtimeCache.get(replayKey)) {
      throw new PartnerProgramError("Partner content signature was already used.", 401);
    }

    const valid = await publicClient.verifyMessage({
      address: normalizedAddress as `0x${string}`,
      message: input.message,
      signature: input.signature,
    });

    if (!valid) {
      throw new PartnerProgramError("Invalid partner content signature.", 401);
    }

    runtimeCache.set(replayKey, true, PARTNER_CONTENT_SUBMISSION_SIGNATURE_TTL_MS);

    return {
      normalizedAddress,
      normalizedUrl,
    };
  }

  async getDashboard(address: string) {
    const normalizedAddress = normalizeAddress(address);
    const member = await this.findMemberByAddress(normalizedAddress);
    const currentWeekStartUtc = toDateKey(getCurrentUtcWeekStart());
    const nextDistributionAt = getNextUtcWeekStart().toISOString();

    if (!member) {
      return {
        state: "not_whitelisted" as const,
        currentWeekStartUtc,
        nextDistributionAt,
        member: null,
        metrics: buildMetricsPayload(),
      };
    }

    const context = await this.buildMemberContext(member);
    return {
      state: buildMemberState(member),
      currentWeekStartUtc,
      nextDistributionAt,
      member: context.memberPayload,
      metrics: context.metrics,
    };
  }

  async getHistory(address: string) {
    const normalizedAddress = normalizeAddress(address);
    const member = await this.findMemberByAddress(normalizedAddress);
    const currentWeekStartUtc = toDateKey(getCurrentUtcWeekStart());

    if (!member) {
      return {
        state: "not_whitelisted" as const,
        currentWeekStartUtc,
        rows: [] as PartnerHistoryRowPayload[],
      };
    }

    const context = await this.buildMemberContext(member);
    return {
      state: buildMemberState(member),
      currentWeekStartUtc,
      rows: context.history,
    };
  }

  async getSubmissions(address: string) {
    const normalizedAddress = normalizeAddress(address);
    const member = await this.findMemberByAddress(normalizedAddress);

    if (!member) {
      return {
        state: "not_whitelisted" as const,
        summary: this.buildContentSubmissionSummary([]),
        rows: [] as PartnerContentSubmissionPayload[],
      };
    }

    const rows = (await this.loadContentSubmissions(Number(member.id))).map((row) =>
      this.buildContentSubmissionPayload(row)
    );

    return {
      state: buildMemberState(member),
      summary: this.buildContentSubmissionSummary(rows),
      rows,
    };
  }

  async submitContent(input: PartnerContentSubmissionInput, requestIp: string) {
    const { normalizedAddress, normalizedUrl } =
      await this.assertContentSubmissionAuthentication(input, requestIp);
    const member = await this.findMemberByAddress(normalizedAddress);

    if (!member || !member.joined_at) {
      throw new PartnerProgramError("Only joined partners can submit content.", 403);
    }

    const xAccount = await this.loadConnectedXAccount(Number(member.user_id));
    if (!xAccount) {
      throw new PartnerProgramError("Connect X before submitting partner content.", 403);
    }

    const submittedAt = new Date().toISOString();
    const platform = detectPartnerContentPlatform(normalizedUrl);

    const { data, error } = await postgresDb
      .from("partner_content_submissions")
      .insert({
        partner_member_id: Number(member.id),
        partner_user_id: Number(member.user_id),
        content_url: normalizedUrl,
        normalized_url: normalizedUrl,
        platform,
        submitted_at: submittedAt,
        created_at: submittedAt,
      })
      .select("*")
      .maybeSingle();

    if (error) {
      if (error.code === "23505") {
        throw new PartnerProgramError("This content link was already submitted.", 409);
      }

      throw new Error(`Submit partner content: ${error.message}`);
    }

    const submission = this.buildContentSubmissionPayload(
      (data as PartnerContentSubmissionRow | null) ?? {
        id: 0,
        partner_member_id: member.id,
        partner_user_id: member.user_id,
        content_url: normalizedUrl,
        normalized_url: normalizedUrl,
        platform,
        submitted_at: submittedAt,
      }
    );
    const rows = (await this.loadContentSubmissions(Number(member.id))).map((row) =>
      this.buildContentSubmissionPayload(row)
    );

    return {
      success: true,
      submission,
      summary: this.buildContentSubmissionSummary(rows),
      rows,
    } as const;
  }

  async joinProgram(input: PartnerJoinInput, requestIp: string) {
    const normalizedAddress = await this.assertJoinAuthentication(input, requestIp);
    const member = await this.findMemberByAddress(normalizedAddress);

    if (!member) {
      throw new PartnerProgramError(
        "You are not whitelisted for the partner program.",
        403
      );
    }

    if (member.joined_at) {
      return {
        success: true,
        status: "joined",
        joinedAt: member.joined_at,
      } as const;
    }

    const joinedAt = new Date().toISOString();
    const { error } = await postgresDb
      .from("partner_program_members")
      .update({
        status: "joined",
        joined_at: joinedAt,
        updated_at: joinedAt,
      })
      .eq("id", member.id);

    if (error) {
      throw new Error(`Join partner program: ${error.message}`);
    }

    return {
      success: true,
      status: "joined",
      joinedAt,
    } as const;
  }

  async getAdminLeaderboard(search?: string) {
    const currentWeekStartUtc = toDateKey(getCurrentUtcWeekStart());
    const nextDistributionAt = getNextUtcWeekStart().toISOString();
    const members = await this.loadAllMembers();
    const memberIds = members.map((member) => Number(member.id));
    const userIds = members.map((member) => Number(member.user_id));

    const [users, referralCounts, alltimeMetrics, weeklyMetrics, closedWeeklyMetrics, distributions] =
      await Promise.all([
        this.loadUsersByIds(userIds),
        this.loadReferralCounts(memberIds),
        this.loadAlltimeMetrics(memberIds),
        this.loadWeeklyMetrics(memberIds),
        this.loadWeeklyMetrics(memberIds, { beforeWeekStart: currentWeekStartUtc }),
        this.loadDistributions(memberIds),
      ]);

    const currentWeekMetrics = new Map<number, WeeklyMetricRow>();
    for (const row of weeklyMetrics) {
      if (normalizeDateOnlyValue(row.week_start_utc) === currentWeekStartUtc) {
        currentWeekMetrics.set(Number(row.partner_member_id), row);
      }
    }

    const closedWeeklyByMember = new Map<number, WeeklyMetricRow[]>();
    for (const row of closedWeeklyMetrics) {
      const key = Number(row.partner_member_id);
      const list = closedWeeklyByMember.get(key) ?? [];
      list.push(row);
      closedWeeklyByMember.set(key, list);
    }

    const distributionsByMember = new Map<number, Map<string, DistributionRow>>();
    for (const row of distributions) {
      const key = Number(row.partner_member_id);
      const list = distributionsByMember.get(key) ?? new Map<string, DistributionRow>();
      list.set(normalizeDateOnlyValue(row.week_start_utc), row);
      distributionsByMember.set(key, list);
    }

    const normalizedSearch = String(search || "").trim().toLowerCase();
    const rows = members
      .map((member) => {
        const user = users.get(Number(member.user_id));
        if (!user) {
          return null;
        }

        const metrics = this.buildMemberMetrics({
          memberId: Number(member.id),
          referralCounts,
          alltimeMetrics,
          currentWeekMetrics,
          closedWeeklyMetrics: closedWeeklyByMember,
          distributionsByMember,
        });

        return {
          member: this.buildMemberPayload(member, user),
          metrics,
        };
      })
      .filter(
        (
          row
        ): row is {
          member: PartnerMemberPayload;
          metrics: PartnerMetricsPayload;
        } => Boolean(row)
      )
      .filter((row) => {
        if (!normalizedSearch) {
          return true;
        }

        return (
          row.member.address.includes(normalizedSearch) ||
          row.member.referralCode.toLowerCase().includes(normalizedSearch)
        );
      })
      .sort((a, b) => {
        return (
          b.metrics.latestClosedWeekDueRewardUsd - a.metrics.latestClosedWeekDueRewardUsd ||
          b.metrics.unpaidRewardUsdTotal - a.metrics.unpaidRewardUsdTotal ||
          b.metrics.rewardCurrentWeekUsd - a.metrics.rewardCurrentWeekUsd ||
          b.metrics.rewardAllTimeUsd - a.metrics.rewardAllTimeUsd ||
          a.member.address.localeCompare(b.member.address)
        );
      });

    return {
      currentWeekStartUtc,
      nextDistributionAt,
      rows,
    };
  }

  async upsertMember(input: {
    address?: string;
    feeSharePercent?: number;
    isAdmin?: boolean;
  }) {
    const normalizedAddress = normalizeAddress(String(input.address || ""));
    const feeSharePercent = normalizeFeeSharePercent(input.feeSharePercent);
    const nextIsAdmin = Boolean(input.isAdmin);
    const user = await pointsEngine.getOrCreate(normalizedAddress);
    const existing = await this.findMemberByAddress(normalizedAddress);
    const nowIso = new Date().toISOString();

    if (!existing) {
      const { data: created, error: createError } = await postgresDb
        .from("partner_program_members")
        .insert({
          user_id: user.id,
          wallet_address: normalizedAddress,
          status: "whitelisted",
          whitelisted_at: nowIso,
          joined_at: null,
          current_fee_share_percent: feeSharePercent,
          is_admin: nextIsAdmin,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select("*")
        .maybeSingle();

      if (createError) {
        throw new Error(`Create partner member: ${createError.message}`);
      }

      if (!created) {
        throw new Error("Create partner member: failed to load created row.");
      }

      const { error: historyError } = await postgresDb
        .from("partner_fee_share_history")
        .insert({
          partner_member_id: Number((created as MemberRow).id),
          fee_share_percent: feeSharePercent,
          effective_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        });

      if (historyError) {
        throw new Error(`Create partner fee history: ${historyError.message}`);
      }

      return this.getAdminMemberDetail(normalizedAddress);
    }

    const currentFeeSharePercent = toNumber(existing.current_fee_share_percent);
    const feeChanged = currentFeeSharePercent !== feeSharePercent;

    const { error: memberUpdateError } = await postgresDb
      .from("partner_program_members")
      .update({
        current_fee_share_percent: feeSharePercent,
        is_admin: nextIsAdmin,
        updated_at: nowIso,
      })
      .eq("id", existing.id);

    if (memberUpdateError) {
      throw new Error(`Update partner member: ${memberUpdateError.message}`);
    }

    if (feeChanged) {
      const { error: closeError } = await postgresDb
        .from("partner_fee_share_history")
        .update({
          ended_at: nowIso,
          updated_at: nowIso,
        })
        .eq("partner_member_id", existing.id)
        .is("ended_at", null);

      if (closeError) {
        throw new Error(`Close partner fee history: ${closeError.message}`);
      }

      const { error: insertError } = await postgresDb
        .from("partner_fee_share_history")
        .insert({
          partner_member_id: existing.id,
          fee_share_percent: feeSharePercent,
          effective_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        });

      if (insertError) {
        throw new Error(`Insert partner fee history: ${insertError.message}`);
      }
    } else {
      const { data: activeHistory, error: activeHistoryError } = await postgresDb
        .from("partner_fee_share_history")
        .select("id")
        .eq("partner_member_id", existing.id)
        .is("ended_at", null)
        .maybeSingle();

      if (activeHistoryError) {
        throw new Error(`Load active partner fee history: ${activeHistoryError.message}`);
      }

      if (!activeHistory) {
        const { error: insertError } = await postgresDb
          .from("partner_fee_share_history")
          .insert({
            partner_member_id: existing.id,
            fee_share_percent: feeSharePercent,
            effective_at: existing.whitelisted_at || nowIso,
            created_at: nowIso,
            updated_at: nowIso,
          });

        if (insertError) {
          throw new Error(`Repair partner fee history: ${insertError.message}`);
        }
      }
    }

    return this.getAdminMemberDetail(normalizedAddress);
  }

  async getAdminMemberDetail(address: string) {
    const normalizedAddress = normalizeAddress(address);
    const member = await this.findMemberByAddress(normalizedAddress);
    if (!member) {
      throw new PartnerProgramError("Partner member not found.", 404);
    }

    const context = await this.buildMemberContext(member);
    const currentWeekStartUtc = context.history[0]?.weekStartUtc
      ? toDateKey(getCurrentUtcWeekStart())
      : toDateKey(getCurrentUtcWeekStart());
    const nextDistributionAt = getNextUtcWeekStart().toISOString();
    const [referredUsers, referredAlltimeMetrics, referredWeeklyMetrics, contentSubmissions] =
      await Promise.all([
      this.loadReferredUsers(Number(member.id)),
      this.loadReferredUserAlltimeMetrics(Number(member.id)),
      this.loadReferredUserWeeklyMetrics(Number(member.id), toDateKey(getCurrentUtcWeekStart())),
      this.loadContentSubmissions(Number(member.id)),
    ]);

    const referredUserRows = referredUsers
      .map((row) => {
        const refereeUserId = Number(row.referee_user_id);
        const alltime = referredAlltimeMetrics.get(refereeUserId);
        const weekly = referredWeeklyMetrics.get(refereeUserId);
        return {
          refereeUserId,
          address: normalizeAddress(row.referee_address),
          referralActivatedAt: row.referral_activated_at,
          hasQualifiedTrade: Boolean(alltime && toNumber(alltime.swap_count_total) > 0),
          qualifyingVolumeAllTimeUsd: toNumber(alltime?.qualifying_volume_all_time_usd),
          qualifyingVolumeCurrentWeekUsd: toNumber(weekly?.qualifying_volume_usd),
          rewardAllTimeUsd: toNumber(alltime?.reward_all_time_usd),
          rewardCurrentWeekUsd: toNumber(weekly?.reward_usd),
          firstQualifyingTradeAt: alltime?.first_qualifying_trade_at || null,
          lastQualifyingTradeAt: alltime?.last_qualifying_trade_at || null,
        };
      })
      .sort((a, b) => {
        return (
          b.qualifyingVolumeCurrentWeekUsd - a.qualifyingVolumeCurrentWeekUsd ||
          b.qualifyingVolumeAllTimeUsd - a.qualifyingVolumeAllTimeUsd ||
          a.address.localeCompare(b.address)
        );
      });
    const submissionRows = contentSubmissions.map((row) =>
      this.buildContentSubmissionPayload(row)
    );

    return {
      currentWeekStartUtc,
      nextDistributionAt,
      member: context.memberPayload,
      metrics: context.metrics,
      history: context.history,
      submissionSummary: this.buildContentSubmissionSummary(submissionRows),
      submissions: submissionRows,
      referredUsers: referredUserRows,
    };
  }

  async markDistributionPaid(input: {
    address?: string;
    weekStartUtc?: string;
    payoutUsdcAmount?: number;
    payoutTxHash?: string;
    paidNotes?: string | null;
  }) {
    const normalizedAddress = normalizeAddress(String(input.address || ""));
    const weekStartUtc = normalizeWeekStartDate(input.weekStartUtc);
    const payoutUsdcAmount = Number(input.payoutUsdcAmount);
    if (!Number.isFinite(payoutUsdcAmount) || payoutUsdcAmount < 0) {
      throw new PartnerProgramError("Payout USDC amount must be zero or greater.", 400);
    }

    const payoutTxHash = normalizeTxHash(input.payoutTxHash);
    const currentWeekStartUtc = toDateKey(getCurrentUtcWeekStart());
    if (weekStartUtc >= currentWeekStartUtc) {
      throw new PartnerProgramError("Only closed weeks can be marked as paid.", 400);
    }

    const member = await this.findMemberByAddress(normalizedAddress);
    if (!member) {
      throw new PartnerProgramError("Partner member not found.", 404);
    }

    const { data: weeklyData, error: weeklyError } = await postgresDb
      .from("partner_program_member_weekly_metrics")
      .select("*")
      .eq("partner_member_id", member.id)
      .eq("week_start_utc", weekStartUtc)
      .maybeSingle();

    if (weeklyError) {
      throw new Error(`Load weekly partner metrics: ${weeklyError.message}`);
    }

    const weekly = (weeklyData as WeeklyMetricRow | null) ?? null;
    if (!weekly) {
      throw new PartnerProgramError(
        "No qualifying partner volume exists for that closed week.",
        404
      );
    }

    const referralCounts = await this.loadReferralCounts([Number(member.id)]);
    const referredUsersTotal = toNumber(
      referralCounts.get(Number(member.id))?.referred_users_total
    );
    const paidAt = new Date().toISOString();
    const { error: upsertError } = await postgresDb
      .from("partner_reward_distributions")
      .upsert(
        {
          partner_member_id: Number(member.id),
          week_start_utc: weekStartUtc,
          week_end_utc: addUtcDays(weekStartUtc, 7),
          qualifying_volume_usd: toNumber(weekly.qualifying_volume_usd),
          protocol_fee_usd: toNumber(weekly.protocol_fee_usd),
          reward_usd: toNumber(weekly.reward_usd),
          min_fee_share_percent:
            weekly.min_fee_share_percent != null
              ? toNumber(weekly.min_fee_share_percent)
              : null,
          max_fee_share_percent:
            weekly.max_fee_share_percent != null
              ? toNumber(weekly.max_fee_share_percent)
              : null,
          referred_users_total: referredUsersTotal,
          traded_users_total: toNumber(weekly.traded_users_total),
          payout_usdc_amount: Math.round(payoutUsdcAmount * 1_000_000) / 1_000_000,
          payout_tx_hash: payoutTxHash,
          paid_at: paidAt,
          paid_notes: input.paidNotes?.trim() || null,
          updated_at: paidAt,
        },
        {
          onConflict: "partner_member_id,week_start_utc",
        }
      );

    if (upsertError) {
      throw new Error(`Mark partner distribution as paid: ${upsertError.message}`);
    }

    return {
      success: true,
      weekStartUtc,
      paidAt,
    } as const;
  }
}

export const partnerProgramService = new PartnerProgramService();
export const PARTNER_PROGRAM_FEE_RATE = PARTNER_PROTOCOL_FEE_RATE;
export const PARTNER_PROGRAM_JOIN_STATEMENT = PARTNER_JOIN_STATEMENT;
