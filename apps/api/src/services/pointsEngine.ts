import { createHash } from "crypto";
import {
  createPublicClient,
  encodeFunctionData,
  decodeFunctionData,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { base } from "viem/chains";
import { getPaymentStatus } from "@base-org/account/payment";
import { postgresDb } from "./postgres";
import {
  getBaseRpcEndpoints,
  getRotatingBaseRpcEndpoint,
  type BaseRpcEndpoint,
} from "../utils/baseRpc";
import {
  footprintAirdropService,
  type FootprintLookupResult,
  type FootprintLookupSource,
} from "./footprintAirdrop";
import { xVerificationService } from "./xVerification";
import { runtimeCache } from "../utils/runtimeCache";

function isEnabledFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

const CFG = {
  CHECK_IN: 100,
  SWAP: 50,
  SWEEP_PER_TOKEN: 50,
  BRIDGE_PER_TOKEN: 50,
  BURN_PER_TOKEN: 50,

  SWEEP_MULTIPLIER: 5,
  BRIDGE_MULTIPLIER: 10,
  BURN_MULTIPLIER: 2,

  CAP_SWAP: 500,
  CAP_SWEEP: 5_000,
  CAP_BRIDGE: 10_000,
  CAP_BURN: 2_000,

  REFERRAL_SIGNUP: 500,
  REFERRAL_COMMISSION_PCT: Number(process.env.REFERRAL_COMMISSION_PCT || "20"),

  STREAK_LENGTH: 30,
  STREAK_BOOST_STEP_PERCENT: 10,
  MAX_STREAK_BOOST_PERCENT: 300,

  CHECK_IN_FEE_USD: 0,
  FOOTPRINT_CLAIM_FEE_USD: 0,
  STREAK_RESTORE_FEE_USD: 1,
  SPIN_TICKETS_PER_CHECK_IN: 3,
  SPIN_TICKET_COST: 1,
} as const;

const STREAK_RECOVERY_ENABLED = isEnabledFlag(process.env.STREAK_RECOVERY_ENABLED);

const REFERRAL_FOUNDER_PASS_CONTRACT =
  process.env.REFERRAL_FOUNDER_PASS_CONTRACT || "";
const REFERRAL_FOUNDER_PASS_BONUS_PCT = Number(
  process.env.REFERRAL_FOUNDER_PASS_BONUS_PCT || "60"
);
const REFERRAL_COFOUNDER_PASS_CONTRACT =
  process.env.REFERRAL_COFOUNDER_PASS_CONTRACT || "";
const REFERRAL_COFOUNDER_PASS_BONUS_PCT = Number(
  process.env.REFERRAL_COFOUNDER_PASS_BONUS_PCT || "30"
);

const BASE_RPC_URL =
  process.env.BASE_RPC_URL ||
  process.env.NEXT_PUBLIC_BASE_RPC_URL ||
  "https://mainnet.base.org";
const STREAK_SAVE_RECIPIENT =
  process.env.STREAK_SAVE_RECIPIENT ||
  process.env.NEXT_PUBLIC_STREAK_SAVE_RECIPIENT ||
  "0xe641fB39Fd807B536f37F9268938D67587302E5d";
const STREAK_SAVE_USDC_ADDRESS =
  process.env.STREAK_SAVE_USDC_ADDRESS ||
  process.env.NEXT_PUBLIC_STREAK_SAVE_USDC_ADDRESS ||
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FOOTPRINT_CLAIM_RECIPIENT =
  process.env.FOOTPRINT_CLAIM_RECIPIENT ||
  process.env.NEXT_PUBLIC_FOOTPRINT_CLAIM_RECIPIENT ||
  STREAK_SAVE_RECIPIENT;
const FOOTPRINT_CLAIM_USDC_ADDRESS =
  process.env.FOOTPRINT_CLAIM_USDC_ADDRESS ||
  process.env.NEXT_PUBLIC_FOOTPRINT_CLAIM_USDC_ADDRESS ||
  STREAK_SAVE_USDC_ADDRESS;
const FOOTPRINT_FOLLOW_TARGETS = {
  dustswap: {
    userId:
      process.env.FOOTPRINT_DUSTSWAP_X_USER_ID ||
      process.env.DUSTSWAP_X_USER_ID ||
      null,
    username:
      process.env.FOOTPRINT_DUSTSWAP_X_USERNAME ||
      process.env.DUSTSWAP_X_USERNAME ||
      "DustswapOnBase",
  },
} as const;
const SPIN_CONTRACT_ADDRESS = (
  process.env.SPIN_CONTRACT_ADDRESS ||
  process.env.NEXT_PUBLIC_SPIN_CONTRACT_ADDRESS ||
  ""
).toLowerCase();
const ENTRY_POINT_V06_ADDRESS = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
const DEFAULT_ETH_PRICE_USD = Number(process.env.DEFAULT_ETH_PRICE_USD || "3500");
const REFERRAL_APPLY_IDEMPOTENCY_TTL_MS = 30 * 1000;
const REFERRAL_APPLY_TERMINAL_TTL_MS = 30 * 1000;
const REFERRAL_LEADERBOARD_SNAPSHOT_TTL_MS = 4 * 60 * 60 * 1000;
const ADMIN_POINT_GRANT_ACTION = "admin_manual_pp_grant";
const ADMIN_POINT_GRANT_MAX_BATCH_SIZE = 500;
const PRICE_SCALE = 100_000_000;
const WEI_PER_ETH = 10n ** 18n;
const USER_CREATE_MAX_ATTEMPTS = 5;
const REFERRAL_LEDGER_UPDATE_MAX_ATTEMPTS = 5;
const POINTS_SUMMARY_CACHE_TTL_MS = 15_000;
const LEADERBOARD_CACHE_TTL_MS = 60_000;
const FOOTPRINT_STATUS_CACHE_TTL_MS = 2 * 60 * 1000;
const LEADERBOARD_FALLBACK_USER_FILTER =
  "total_points.gt.0,last_check_in.not.is.null,current_streak.gt.0,spin_tickets.gt.0";
const ENTRY_POINT_HANDLE_OPS_ABI = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
]);
const SMART_WALLET_EXECUTION_ABI = parseAbi([
  "function execute(address target,uint256 value,bytes data)",
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
]);
const SPIN_TRIGGER_ABI = parseAbi([
  "function spin()",
  "event SpinTriggered(address indexed player,uint256 indexed playerNonce)",
]);
const SPIN_FUNCTION_SELECTOR = encodeFunctionData({
  abi: SPIN_TRIGGER_ABI,
  functionName: "spin",
})
  .slice(0, 10)
  .toLowerCase();

const baseClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
});

type BasePublicClient = typeof baseClient;

function isSameBaseRpcEndpoint(a: BaseRpcEndpoint, b: BaseRpcEndpoint) {
  return (
    a.url === b.url &&
    JSON.stringify(a.headers || {}) === JSON.stringify(b.headers || {})
  );
}

function getOrderedBaseRpcEndpoints() {
  const firstEndpoint = getRotatingBaseRpcEndpoint();
  return [
    firstEndpoint,
    ...getBaseRpcEndpoints().filter(
      (endpoint) => !isSameBaseRpcEndpoint(endpoint, firstEndpoint)
    ),
  ];
}

async function readFromBaseRpc<T>(
  operation: (client: BasePublicClient) => Promise<T>,
  description: string
) {
  let lastError: Error | null = null;

  for (const endpoint of getOrderedBaseRpcEndpoints()) {
    const client = createPublicClient({
      chain: base,
      transport: http(endpoint.url, {
        fetchOptions: endpoint.headers
          ? {
              headers: endpoint.headers,
            }
          : undefined,
      }),
    });

    try {
      return await operation(client);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`${description}: ${lastError?.message || "Base RPC request failed"}`);
}

function getBaseTransaction(hash: `0x${string}`) {
  return readFromBaseRpc(
    (client) => client.getTransaction({ hash }),
    "Load Base transaction"
  );
}

function getBaseTransactionReceipt(hash: `0x${string}`) {
  return readFromBaseRpc(
    (client) => client.getTransactionReceipt({ hash }),
    "Load Base transaction receipt"
  );
}

function getBaseBlock(blockNumber: bigint) {
  return readFromBaseRpc(
    (client) => client.getBlock({ blockNumber }),
    "Load Base block"
  );
}

type UserRecord = {
  id: number;
  address: string;
  referral_code: string;
  referred_by: number | null;
  total_points: number;
  current_streak: number;
  longest_streak: number;
  last_check_in: string | null;
  spin_tickets?: number | null;
};

type SocialAccountRecord = {
  user_id: number;
  platform: string;
  platform_user_id: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  updated_at?: string | null;
};

type UserProfileRecord = {
  user_id: number;
  username: string | null;
  display_name: string | null;
  discord_username: string | null;
  pfp_url: string | null;
  pfp_storage_key: string | null;
  updated_at?: string | null;
};

type CachedFarcasterProfile = {
  fid: string | null;
  username: string | null;
  displayName: string | null;
  pfpUrl: string | null;
  updatedAt: string | null;
};

function normalizeUserRecord(row: Partial<UserRecord> | null): UserRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id || 0),
    address: String(row.address || "").toLowerCase(),
    referral_code: String(row.referral_code || ""),
    referred_by: row.referred_by == null ? null : Number(row.referred_by),
    total_points: Number(row.total_points || 0),
    current_streak: Number(row.current_streak || 0),
    longest_streak: Number(row.longest_streak || 0),
    last_check_in: row.last_check_in || null,
    spin_tickets: row.spin_tickets == null ? 0 : Number(row.spin_tickets),
  };
}

function isMissingUserProfilesTable(error: { code?: string; message?: string } | null) {
  if (!error) {
    return false;
  }

  const message = String(error.message || "").toLowerCase();
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    (message.includes("user_profiles") && message.includes("schema cache"))
  );
}

type LeaderboardKind = "particle_points" | "referral" | "volume";

type LeaderboardMetricRow = {
  userId: number;
  address: string;
  totalPoints: number;
  referralPoints: number;
  referredUsers: number;
  swapVolume: number;
};

type LeaderboardEntry = LeaderboardMetricRow & {
  rank: number;
  profile: CachedFarcasterProfile | null;
};

type LeaderboardHubResponse = {
  type: LeaderboardKind;
  limit: number;
  page: number;
  pageSize: number;
  totalEntries: number;
  totalPages: number;
  totalUserCount: number;
  totalParticlePoints: number;
  viewer: LeaderboardEntry | null;
  entries: LeaderboardEntry[];
};

type ReferralApplyResult = {
  applied: boolean;
  message: string;
  deferred?: boolean;
  idempotent?: boolean;
};

type DailyAssetPriceRecord = {
  id: number;
  asset_symbol: string;
  price_date: string;
  price_usd: number;
  source: string;
  metadata: Record<string, unknown> | null;
};

type PriceFeedQuote = {
  priceUsd: number;
  source: string;
  metadata?: Record<string, unknown>;
};

type StreakStatus = "ready" | "active" | "checked_in" | "broken";
type SaveAsset = "eth" | "usdc";
type FootprintFollowTaskKey = keyof typeof FOOTPRINT_FOLLOW_TARGETS;

type StreakSnapshot = {
  status: StreakStatus;
  checkedInToday: boolean;
  isBroken: boolean;
  missedStreak: boolean;
  storedStreak: number;
  activeStreak: number;
  recoverableStreak: number;
  boostPercent: number;
  recoverableBoostPercent: number;
  todayEndsAt: string;
  nextCheckInAt: string;
};

type FeeConfig = {
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

type VerifiedPayment = {
  asset: SaveAsset;
  amount: string;
  amountUsd: number;
  priceDate: string;
  ethPriceUsd: number;
};

type PaymentVerificationTarget = {
  allowBasePay?: boolean;
  recipient: string;
  usdcAddress: string;
};

type UserSweepStatsRow = {
  dust_swept: number | string | null;
  swap_volume: number | string | null;
  tokens_burned: number | string | null;
};

type UserReferralStatsRow = {
  friends_joined: number | string | null;
  points_earned: number | string | null;
};

type PointsOverviewRow = {
  total_particle_points: number | string | null;
  total_user_count: number | string | null;
};

type ReferralLeaderboardRow = {
  address: string;
  rank: number | string;
  referral_points: number | string | null;
  referred_users: number | string | null;
  total_points: number | string | null;
  user_id: number | string;
};

type ReferralLeaderboardCountRow = {
  total_entries: number | string | null;
};

type ReferralLeaderboardSnapshotMetaRow = {
  refreshed_at: string | null;
  total_entries: number | string | null;
};

type ReferralPointEventRow = {
  total_awarded: number | string | null;
  user_id: number | string | null;
};

type ReferralReferrerRow = {
  referrer_id: number | string | null;
};

type ParticlePointLeaderboardRow = {
  address: string;
  current_streak: number | string | null;
  last_check_in: string | null;
  rank: number | string;
  total_points: number | string | null;
  user_id: number | string;
};

type VolumeLeaderboardRow = {
  address: string;
  rank: number | string;
  swap_volume: number | string | null;
  total_points: number | string | null;
  user_id: number | string;
};

type PointEventRow = {
  id: number | string;
  points: number | string | null;
  total_awarded: number | string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

type AdminPointGrantEventRow = {
  user_id: number | string | null;
  points: number | string | null;
  total_awarded: number | string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

type AdminPointGrantInput = {
  address: string;
  points: number;
};

type AdminPointGrantResult = {
  address: string;
  userId: number;
  requestedPoints: number;
  totalAwarded: number;
  totalPoints: number;
  createdAt: string | null;
  idempotent: boolean;
};

type ParticlePointLeaderboardEntryRow = {
  address: string;
  currentStreak: number;
  lastCheckIn: string | null;
  rank: number;
  totalPoints: number;
  userId: number;
};

type ParticlePointFallbackUserRow = {
  address: string;
  current_streak: number | string | null;
  id: number | string;
  last_check_in: string | null;
  spin_tickets?: number | string | null;
  total_points: number | string | null;
};

type AddPointsOptions = {
  applyStreakBoost?: boolean;
  applyReferralCommission?: boolean;
};

type SpinRewardKind = "pp" | "usdc";

type SpinRewardOption = {
  key: string;
  label: string;
  probability: number;
  type: SpinRewardKind;
  amount: number;
  pointsAwarded: number;
};

type SpinHistoryRow = {
  id: number | string;
  tx_hash: string;
  reward_key: string;
  reward_label: string;
  reward_type: SpinRewardKind;
  reward_amount: number | string;
  reward_points: number | string | null;
  reward_probability: number | string | null;
  ticket_cost: number | string | null;
  execution_type: string | null;
  status: string | null;
  created_at: string | null;
};

const SPIN_REWARDS: readonly SpinRewardOption[] = [
  {
    key: "50_pp",
    label: "50 PP",
    probability: 25,
    type: "pp",
    amount: 50,
    pointsAwarded: 50,
  },
  {
    key: "100_pp",
    label: "100 PP",
    probability: 20,
    type: "pp",
    amount: 100,
    pointsAwarded: 100,
  },
  {
    key: "150_pp",
    label: "150 PP",
    probability: 20,
    type: "pp",
    amount: 150,
    pointsAwarded: 150,
  },
  {
    key: "200_pp",
    label: "200 PP",
    probability: 15,
    type: "pp",
    amount: 200,
    pointsAwarded: 200,
  },
  {
    key: "250_pp",
    label: "250 PP",
    probability: 15,
    type: "pp",
    amount: 250,
    pointsAwarded: 250,
  },
  {
    key: "500_pp",
    label: "500 PP",
    probability: 5,
    type: "pp",
    amount: 500,
    pointsAwarded: 500,
  },
  {
    key: "1_usdc",
    label: "1 USDC",
    probability: 0,
    type: "usdc",
    amount: 1,
    pointsAwarded: 0,
  },
  {
    key: "5_usdc",
    label: "5 USDC",
    probability: 0,
    type: "usdc",
    amount: 5,
    pointsAwarded: 0,
  },
] as const;

function genCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return (
    "DUST-" +
    Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  );
}

function getUtcStartOfDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getUtcDayKey(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function getUtcDayEnd(date = new Date()) {
  const end = getUtcStartOfDay(date);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

function getYesterdayUtcKey(date = new Date()) {
  const yesterday = getUtcStartOfDay(date);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return getUtcDayKey(yesterday);
}

function getYesterdayUtcDate(date = new Date()) {
  const yesterday = getUtcStartOfDay(date);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday;
}

function getBoostPercent(streak: number) {
  if (streak <= 0) {
    return 0;
  }

  return Math.min(
    CFG.MAX_STREAK_BOOST_PERCENT,
    streak * CFG.STREAK_BOOST_STEP_PERCENT
  );
}

function getDailyCheckInPoints(streak: number) {
  const multiplier = 1 + getBoostPercent(streak) / 100;
  return Math.max(0, Math.floor(CFG.CHECK_IN * multiplier));
}

function safeMetadata(meta: unknown, extra: Record<string, unknown>) {
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return {
      ...(meta as Record<string, unknown>),
      ...extra,
    };
  }

  return {
    ...extra,
    value: meta ?? null,
  };
}

function buildStreakSnapshot(
  user: Pick<UserRecord, "current_streak" | "last_check_in">,
  now = new Date()
): StreakSnapshot {
  const todayKey = getUtcDayKey(now);
  const yesterdayKey = getYesterdayUtcKey(now);
  const lastCheckInKey = getUtcDayKey(user.last_check_in);
  const persistedStreak = Number(user.current_streak || 0);
  const checkedInToday = Boolean(lastCheckInKey && lastCheckInKey === todayKey);
  const checkedInYesterday = Boolean(lastCheckInKey && lastCheckInKey === yesterdayKey);
  const missedStreak =
    persistedStreak > 0 && !checkedInToday && !checkedInYesterday;
  const isBroken = STREAK_RECOVERY_ENABLED && missedStreak;
  const storedStreak =
    missedStreak && !STREAK_RECOVERY_ENABLED ? 0 : persistedStreak;
  const activeStreak = missedStreak ? 0 : storedStreak;
  const recoverableStreak = isBroken ? persistedStreak : 0;
  const todayEndsAt = getUtcDayEnd(now).toISOString();
  const nextCheckInAt = checkedInToday ? todayEndsAt : now.toISOString();

  return {
    status: isBroken
      ? "broken"
      : checkedInToday
        ? "checked_in"
        : activeStreak > 0
          ? "active"
          : "ready",
    checkedInToday,
    isBroken,
    missedStreak,
    storedStreak,
    activeStreak,
    recoverableStreak,
    boostPercent: getBoostPercent(activeStreak),
    recoverableBoostPercent: getBoostPercent(recoverableStreak),
    todayEndsAt,
    nextCheckInAt,
  };
}

function isBoostEligibleAction(action: string) {
  return ![
    "referral_commission",
    "referral_new_user",
    "referral_welcome",
  ].includes(action);
}

function isReferralCommissionEligibleAction(action: string) {
  return ![
    "referral_commission",
    "referral_new_user",
    "referral_welcome",
  ].includes(action);
}

function normalizeDailyPriceRow(row: any): DailyAssetPriceRecord {
  return {
    id: Number(row.id),
    asset_symbol: String(row.asset_symbol),
    price_date: String(row.price_date),
    price_usd: Number(row.price_usd),
    source: String(row.source),
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
  };
}

function getUsdcUnitsForUsd(usdAmount: number) {
  return BigInt(Math.round(usdAmount * 1_000_000));
}

function parseUsdAmount(value: string | number | null | undefined) {
  const normalized = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function buildAdminPointGrantSignature(
  entries: AdminPointGrantInput[],
  note: string
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        note,
        entries: entries.map((entry) => ({
          address: entry.address,
          points: entry.points,
        })),
      })
    )
    .digest("hex");
}

function firstRow<T>(rows: T[] | null | undefined) {
  return rows?.[0] ?? null;
}

function isPostgresUniqueViolation(error: { code?: string; message?: string } | null | undefined) {
  return (
    error?.code === "23505" ||
    String(error?.message || "")
      .toLowerCase()
      .includes("duplicate key")
  );
}

function calculateEthWeiFromUsd(usdAmount: number, ethPriceUsd: number) {
  const usdScaled = BigInt(Math.round(usdAmount * PRICE_SCALE));
  const ethPriceScaled = BigInt(Math.round(ethPriceUsd * PRICE_SCALE));

  if (usdScaled < 0n || ethPriceScaled <= 0n) {
    throw new Error("Invalid ETH price snapshot");
  }

  if (usdScaled === 0n) {
    return 0n;
  }

  return (usdScaled * WEI_PER_ETH + ethPriceScaled - 1n) / ethPriceScaled;
}

function buildFeeConfig(
  snapshot: DailyAssetPriceRecord,
  usdTarget: number,
  recipient = STREAK_SAVE_RECIPIENT,
  usdcAddress = STREAK_SAVE_USDC_ADDRESS
): FeeConfig {
  const usdcUnits = getUsdcUnitsForUsd(usdTarget);
  const ethWei = calculateEthWeiFromUsd(usdTarget, snapshot.price_usd);

  return {
    chainId: base.id,
    recipient,
    usdcAddress,
    usdTarget,
    usdcAmount: usdTarget.toFixed(2),
    usdcAmountUnits: usdcUnits.toString(),
    ethAmountWei: ethWei.toString(),
    ethAmountDisplay: formatUnits(ethWei, 18),
    ethPriceUsd: snapshot.price_usd,
    priceDate: snapshot.price_date,
  };
}

function normalizeSpinRewardRow(row: SpinHistoryRow) {
  return {
    id: Number(row.id),
    txHash: String(row.tx_hash),
    reward: {
      key: String(row.reward_key),
      label: String(row.reward_label),
      type: row.reward_type,
      amount: Number(row.reward_amount || 0),
      pointsAwarded: Number(row.reward_points || 0),
      probability: Number(row.reward_probability || 0),
    },
    ticketCost: Number(row.ticket_cost || 0),
    executionType: row.execution_type || "eoa",
    status: row.status || "confirmed",
    createdAt: row.created_at,
  };
}

function pickSpinReward() {
  const roll = Math.random() * 100;
  let cursor = 0;

  for (const reward of SPIN_REWARDS) {
    cursor += reward.probability;
    if (roll < cursor) {
      return reward;
    }
  }

  return SPIN_REWARDS[SPIN_REWARDS.length - 1];
}

export class PointsEngine {
  private referralSnapshotRefreshTimer: NodeJS.Timeout | null = null;

  private readonly referralApplyInflight = new Map<
    string,
    {
      code: string;
      promise: Promise<ReferralApplyResult>;
    }
  >();
  private readonly referralApplyRecent = new Map<
    string,
    {
      result: ReferralApplyResult;
      expiresAt: number;
    }
  >();

  private getReferralApplyKey(address: string) {
    return address.trim().toLowerCase();
  }

  private getReferralApplyRecentKey(address: string, code: string) {
    return `${this.getReferralApplyKey(address)}:${code.trim().toUpperCase()}`;
  }

  private getRecentReferralApply(address: string, code: string) {
    const key = this.getReferralApplyRecentKey(address, code);
    const cached = this.referralApplyRecent.get(key);

    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.referralApplyRecent.delete(key);
      return null;
    }

    return cached;
  }

  private rememberReferralApply(
    address: string,
    code: string,
    result: ReferralApplyResult,
    ttlMs = REFERRAL_APPLY_IDEMPOTENCY_TTL_MS
  ) {
    this.referralApplyRecent.set(this.getReferralApplyRecentKey(address, code), {
      result,
      expiresAt: Date.now() + ttlMs,
    });

    return result;
  }

  private rememberTerminalReferralApply(
    address: string,
    code: string,
    message: string
  ) {
    const result = {
      applied: false,
      message,
    } satisfies ReferralApplyResult;

    this.rememberReferralApply(
      address,
      code,
      result,
      REFERRAL_APPLY_TERMINAL_TTL_MS
    );

    return result;
  }

  private getDeferredReferralApplyResult() {
    return {
      applied: false,
      deferred: true,
      message:
        "Complete your first onchain check-in or PP claim to activate this invite code.",
    } satisfies ReferralApplyResult;
  }

  private normalizeStoredAddress(address: string) {
    return address.trim().toLowerCase();
  }

  private async loadUserByNormalizedAddress(normalizedAddress: string) {
    const { data, error } = await postgresDb
      .from("users")
      .select("*")
      .eq("address", normalizedAddress)
      .maybeSingle();

    if (error) {
      throw new Error(`Load existing user: ${error.message}`);
    }

    return normalizeUserRecord((data as Partial<UserRecord> | null) ?? null);
  }

  private async ensureReferralCode(user: UserRecord) {
    if (user.referral_code) {
      return user;
    }

    const normalizedAddress = this.normalizeStoredAddress(user.address);

    for (let attempt = 0; attempt < USER_CREATE_MAX_ATTEMPTS; attempt += 1) {
      const existing = await this.loadUserByNormalizedAddress(normalizedAddress);
      if (existing?.referral_code) {
        return existing;
      }

      const { error } = await postgresDb
        .from("users")
        .update({
          referral_code: genCode(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.id);

      if (error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("duplicate key") ||
          message.includes("unique") ||
          message.includes("referral_code")
        ) {
          continue;
        }

        throw new Error(`Backfill user referral code: ${error.message}`);
      }
    }

    const refreshed = await this.loadUserByNormalizedAddress(normalizedAddress);
    if (refreshed?.referral_code) {
      return refreshed;
    }

    throw new Error("Backfill user referral code: failed to allocate referral code");
  }

  async getOrCreate(address: string): Promise<UserRecord> {
    const normalizedAddress = this.normalizeStoredAddress(address);
    const existing = await this.loadUserByNormalizedAddress(normalizedAddress);

    if (existing) {
      return this.ensureReferralCode(existing);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < USER_CREATE_MAX_ATTEMPTS; attempt += 1) {
      const { error } = await postgresDb.from("users").upsert(
        {
          address: normalizedAddress,
          referral_code: genCode(),
          total_points: 0,
          spin_tickets: 0,
          current_streak: 0,
          longest_streak: 0,
        },
        {
          onConflict: "address",
          ignoreDuplicates: true,
        }
      );

      if (error) {
        lastError = new Error(`Create user: ${error.message}`);
        const message = error.message.toLowerCase();

        if (
          message.includes("duplicate key") ||
          message.includes("unique") ||
          message.includes("referral_code")
        ) {
          continue;
        }

        throw lastError;
      }

      const created = await this.loadUserByNormalizedAddress(normalizedAddress);
      if (created) {
        return this.ensureReferralCode(created);
      }
    }

    const created = await this.loadUserByNormalizedAddress(normalizedAddress);
    if (created) {
      return this.ensureReferralCode(created);
    }

    throw lastError ?? new Error("Create user: failed to create or load user");
  }

  private getPointsSummaryCacheKey(address: string) {
    return `points-summary:${address.toLowerCase()}`;
  }

  private getLeaderboardCacheKey(
    type: LeaderboardKind,
    page: number,
    pageSize: number,
    viewerAddress?: string
  ) {
    return `leaderboard:${type}:${page}:${pageSize}:${(viewerAddress || "").toLowerCase()}`;
  }

  private getFootprintStatusCacheKey(address: string) {
    return `footprint-status:${address.toLowerCase()}`;
  }

  invalidateSummaryCache(address?: string | null) {
    if (!address) {
      runtimeCache.invalidatePrefix("points-summary:");
      return;
    }

    runtimeCache.invalidate(this.getPointsSummaryCacheKey(address));
  }

  invalidateLeaderboardCache() {
    runtimeCache.invalidatePrefix("leaderboard:");
  }

  invalidateFootprintStatusCache(address?: string | null) {
    if (!address) {
      runtimeCache.invalidatePrefix("footprint-status:");
      return;
    }

    runtimeCache.invalidate(this.getFootprintStatusCacheKey(address));
  }

  invalidateUserReadCaches(address?: string | null) {
    this.invalidateSummaryCache(address);
    this.invalidateLeaderboardCache();
    this.invalidateFootprintStatusCache(address);
  }

  startReferralLeaderboardSnapshotScheduler() {
    if (this.referralSnapshotRefreshTimer) {
      return;
    }

    const runRefresh = () => {
      void runtimeCache
        .singleFlight("leaderboard:referral:snapshot-refresh", async () => {
          return this.refreshReferralLeaderboardSnapshot();
        })
        .catch((error) => {
          console.error("[Referral Leaderboard Snapshot] Scheduled refresh failed", error);
        });
    };

    runRefresh();
    this.referralSnapshotRefreshTimer = setInterval(
      runRefresh,
      REFERRAL_LEADERBOARD_SNAPSHOT_TTL_MS
    );
    this.referralSnapshotRefreshTimer.unref?.();
  }

  private async fetchCurrentEthPriceUsd(): Promise<PriceFeedQuote> {
    const sources: Array<() => Promise<PriceFeedQuote>> = [
      async () => {
        const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          throw new Error(`Coinbase ETH price request failed with ${response.status}`);
        }

        const payload = (await response.json()) as {
          data?: {
            amount?: string;
            base?: string;
            currency?: string;
          };
        };

        const priceUsd = parseUsdAmount(payload.data?.amount);
        if (!priceUsd) {
          throw new Error("Coinbase ETH price feed returned an invalid value");
        }

        return {
          priceUsd,
          source: "coinbase_spot",
          metadata: {
            base: payload.data?.base ?? "ETH",
            currency: payload.data?.currency ?? "USD",
          },
        };
      },
      async () => {
        const response = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
          {
            headers: {
              Accept: "application/json",
            },
          }
        );

        if (!response.ok) {
          throw new Error(`CoinGecko ETH price request failed with ${response.status}`);
        }

        const payload = (await response.json()) as {
          ethereum?: {
            usd?: number;
          };
        };

        const priceUsd = parseUsdAmount(payload.ethereum?.usd);
        if (!priceUsd) {
          throw new Error("CoinGecko ETH price feed returned an invalid value");
        }

        return {
          priceUsd,
          source: "coingecko",
        };
      },
    ];

    let lastError: Error | null = null;

    for (const source of sources) {
      try {
        return await source();
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw lastError ?? new Error("ETH price feed is unavailable");
  }

  private async getLatestEthPriceSnapshot() {
    const { data, error } = await postgresDb
      .from("daily_asset_prices")
      .select("*")
      .eq("asset_symbol", "ETH")
      .order("price_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load latest ETH snapshot: ${error.message}`);
    }

    return data ? normalizeDailyPriceRow(data) : null;
  }

  private async getDailyEthPriceSnapshot(date = new Date()) {
    const dateKey = getUtcDayKey(date);
    if (!dateKey) {
      throw new Error("Could not resolve a UTC date for the ETH price snapshot");
    }

    const { data, error } = await postgresDb
      .from("daily_asset_prices")
      .select("*")
      .eq("asset_symbol", "ETH")
      .eq("price_date", dateKey)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load ETH price snapshot: ${error.message}`);
    }

    const upsertRow = async (
      priceUsd: number,
      source: string,
      metadata: Record<string, unknown>
    ) => {
      const { data: inserted, error: upsertError } = await postgresDb
        .from("daily_asset_prices")
        .upsert(
          {
            asset_symbol: "ETH",
            price_date: dateKey,
            price_usd: priceUsd,
            source,
            metadata,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "asset_symbol,price_date",
          }
        )
        .select("*")
        .single();

      if (upsertError) {
        throw new Error(`Failed to save ETH price snapshot: ${upsertError.message}`);
      }

      return normalizeDailyPriceRow(inserted);
    };

    if (data) {
      return normalizeDailyPriceRow(data);
    }

    try {
      const liveQuote = await this.fetchCurrentEthPriceUsd();
      return upsertRow(liveQuote.priceUsd, liveQuote.source, {
        ...(liveQuote.metadata ?? {}),
        syncedAt: new Date().toISOString(),
      });
    } catch {
      const latest = await this.getLatestEthPriceSnapshot();
      if (latest) {
        return upsertRow(latest.price_usd, "fallback_cached", {
          fallbackFromDate: latest.price_date,
        });
      }

      return upsertRow(DEFAULT_ETH_PRICE_USD, "fallback_default", {
        fallbackReason: "price_feed_unavailable",
      });
    }
  }

  private async buildBalancePayload(
    user: Pick<
      UserRecord,
      | "address"
      | "referral_code"
      | "total_points"
      | "current_streak"
      | "longest_streak"
      | "last_check_in"
      | "spin_tickets"
    >,
    options?: {
      rank?: number;
      priceSnapshot?: DailyAssetPriceRecord;
    }
  ) {
    const snapshot = buildStreakSnapshot(user);
    const priceSnapshot =
      options?.priceSnapshot ?? (await this.getDailyEthPriceSnapshot());
    const checkInConfig = buildFeeConfig(priceSnapshot, CFG.CHECK_IN_FEE_USD);
    const saveConfig = buildFeeConfig(priceSnapshot, CFG.STREAK_RESTORE_FEE_USD);
    const rewardStreak = snapshot.isBroken
      ? Math.max(snapshot.recoverableStreak + 2, 1)
      : snapshot.checkedInToday
        ? Math.max(snapshot.activeStreak, 1)
        : Math.max(snapshot.activeStreak + 1, 1);
    const rank =
      typeof options?.rank === "number"
        ? options.rank
        : (() => {
            throw new Error("Rank must be resolved before building the balance payload");
          })();

    return {
      totalPoints: user.total_points,
      rank,
      spinTickets: Number(user.spin_tickets || 0),
      streak: snapshot.activeStreak,
      rawStreak: snapshot.storedStreak,
      recoverableStreak: snapshot.recoverableStreak,
      longestStreak: user.longest_streak,
      referralCode: user.referral_code,
      checkedInToday: snapshot.checkedInToday,
      streakStatus: snapshot.status,
      boostPercent: snapshot.boostPercent,
      recoverableBoostPercent: snapshot.recoverableBoostPercent,
      nextCheckInAt: snapshot.nextCheckInAt,
      dayEndsAt: snapshot.todayEndsAt,
      lastCheckIn: user.last_check_in,
      checkInRewardPoints: getDailyCheckInPoints(rewardStreak),
      nextBoostPercent: getBoostPercent(snapshot.activeStreak + 1),
      boostCapPercent: CFG.MAX_STREAK_BOOST_PERCENT,
      boostStepPercent: CFG.STREAK_BOOST_STEP_PERCENT,
      boostAppliesTo:
        "Self-earned points get the boost. Referral points stay unchanged.",
      streakLength: CFG.STREAK_LENGTH,
      streakRecoveryEnabled: STREAK_RECOVERY_ENABLED,
      checkInConfig,
      saveConfig,
    };
  }

  private async buildBalance(
    user: UserRecord,
    options?: {
      readOnlyPrice?: boolean;
    }
  ) {
    const [rankResult, priceSnapshot] = await Promise.all([
      postgresDb
        .from("users")
        .select("*", { count: "exact", head: true })
        .gt("total_points", user.total_points),
      options?.readOnlyPrice
        ? this.getReadOnlyEthPriceSnapshot()
        : Promise.resolve<DailyAssetPriceRecord | undefined>(undefined),
    ]);

    return this.buildBalancePayload(user, {
      rank: (rankResult.count ?? 0) + 1,
      priceSnapshot,
    });
  }

  private async fetchAllPages<T>(
    fetchPage: (
      from: number,
      to: number
    ) => Promise<{ data: T[] | null; error: { message: string } | null }>
  ) {
    const pageSize = 1000;
    const rows: T[] = [];
    let from = 0;

    while (true) {
      const { data, error } = await fetchPage(from, from + pageSize - 1);
      if (error) {
        throw new Error(error.message);
      }

      const pageRows = data ?? [];
      if (!pageRows.length) {
        break;
      }

      rows.push(...pageRows);
      if (pageRows.length < pageSize) {
        break;
      }

      from += pageSize;
    }

    return rows;
  }

  private normalizeCachedProfile(
    fallback: Pick<
      SocialAccountRecord,
      "platform_user_id" | "username" | "display_name" | "profile_image_url" | "updated_at"
    > | null,
    custom?: Pick<
      UserProfileRecord,
      "username" | "display_name" | "pfp_url" | "updated_at"
    > | null
  ): CachedFarcasterProfile | null {
    if (!fallback && !custom) {
      return null;
    }

    return {
      fid: fallback?.platform_user_id || null,
      username: custom?.username || fallback?.username || null,
      displayName:
        custom?.display_name ||
        custom?.username ||
        fallback?.display_name ||
        fallback?.username ||
        null,
      pfpUrl: custom?.pfp_url || fallback?.profile_image_url || null,
      updatedAt: custom?.updated_at || fallback?.updated_at || null,
    };
  }

  private async fetchCachedProfiles(userIds: number[]) {
    const uniqueUserIds = [...new Set(userIds.filter((value) => Number.isFinite(value)))];
    const profiles = new Map<number, CachedFarcasterProfile>();

    if (!uniqueUserIds.length) {
      return profiles;
    }

    const [socialResult, customResult] = await Promise.all([
      postgresDb
        .from("social_accounts")
        .select(
          "user_id, platform_user_id, username, display_name, profile_image_url, updated_at"
        )
        .eq("platform", "farcaster")
        .in("user_id", uniqueUserIds),
      postgresDb
        .from("user_profiles")
        .select("user_id, username, display_name, pfp_url, updated_at")
        .in("user_id", uniqueUserIds),
    ]);

    if (socialResult.error) {
      throw new Error(`Fetch social profiles: ${socialResult.error.message}`);
    }

    const hasCustomProfiles = !customResult.error;
    if (customResult.error && !isMissingUserProfilesTable(customResult.error)) {
      throw new Error(`Fetch custom profiles: ${customResult.error.message}`);
    }

    if (customResult.error && isMissingUserProfilesTable(customResult.error)) {
      console.warn(
        `[PointsEngine] user_profiles table is not available yet: ${customResult.error.message}`
      );
    }

    const fallbackProfiles = new Map<
      number,
      Pick<
        SocialAccountRecord,
        "user_id" | "platform_user_id" | "username" | "display_name" | "profile_image_url" | "updated_at"
      >
    >();
    const customProfiles = new Map<
      number,
      Pick<UserProfileRecord, "user_id" | "username" | "display_name" | "pfp_url" | "updated_at">
    >();

    for (const row of (socialResult.data ?? []) as Array<
      Pick<
        SocialAccountRecord,
        "user_id" | "platform_user_id" | "username" | "display_name" | "profile_image_url" | "updated_at"
      >
    >) {
      fallbackProfiles.set(Number(row.user_id), row);
    }

    if (hasCustomProfiles) {
      for (const row of (customResult.data ?? []) as Array<
        Pick<UserProfileRecord, "user_id" | "username" | "display_name" | "pfp_url" | "updated_at">
      >) {
        customProfiles.set(Number(row.user_id), row);
      }
    }

    for (const userId of uniqueUserIds) {
      const normalized = this.normalizeCachedProfile(
        fallbackProfiles.get(userId) ?? null,
        customProfiles.get(userId) ?? null
      );
      if (normalized) {
        profiles.set(userId, normalized);
      }
    }

    return profiles;
  }

  private async fetchUsersByIds(userIds: number[]) {
    const uniqueUserIds = [...new Set(userIds.filter((value) => Number.isFinite(value)))];
    const users = new Map<number, Pick<UserRecord, "id" | "address" | "total_points">>();

    if (!uniqueUserIds.length) {
      return users;
    }

    const { data, error } = await postgresDb
      .from("users")
      .select("id, address, total_points")
      .in("id", uniqueUserIds);

    if (error) {
      throw new Error(`Fetch leaderboard users: ${error.message}`);
    }

    for (const row of (data ?? []) as Array<
      Pick<UserRecord, "id" | "address" | "total_points">
    >) {
      users.set(Number(row.id), {
        id: Number(row.id),
        address: String(row.address),
        total_points: Number(row.total_points || 0),
      });
    }

    return users;
  }

  private async getSweepStatsByUserId(userId: number) {
    const { data, error } = await postgresDb.rpc("get_user_sweep_stats", {
      p_user_id: userId,
    });

    if (error) {
      throw new Error(`Load user sweep stats: ${error.message}`);
    }

    const row = firstRow(data as UserSweepStatsRow[] | null);
    return {
      dustSwept: Number(row?.dust_swept || 0),
      swapVolume: Number(row?.swap_volume || 0),
      tokensBurned: Number(row?.tokens_burned || 0),
    };
  }

  private async getReferralStatsByUserId(userId: number) {
    const { data, error } = await postgresDb.rpc("get_user_referral_stats", {
      p_user_id: userId,
    });

    if (error) {
      throw new Error(`Load user referral stats: ${error.message}`);
    }

    const row = firstRow(data as UserReferralStatsRow[] | null);
    return {
      friendsJoined: Number(row?.friends_joined || 0),
      pointsEarned: Number(row?.points_earned || 0),
    };
  }

  private async findExistingUser(address: string) {
    const normalizedAddress = this.normalizeStoredAddress(address);
    const { data, error } = await postgresDb
      .from("users")
      .select("*")
      .eq("address", normalizedAddress)
      .maybeSingle();

    if (error) {
      throw new Error(`Load existing user: ${error.message}`);
    }

    return normalizeUserRecord((data as Partial<UserRecord> | null) ?? null);
  }

  private async getReadOnlyEthPriceSnapshot(date = new Date()) {
    const dateKey = getUtcDayKey(date);
    if (!dateKey) {
      throw new Error("Could not resolve a UTC date for the ETH price snapshot");
    }

    const { data, error } = await postgresDb
      .from("daily_asset_prices")
      .select("*")
      .eq("asset_symbol", "ETH")
      .eq("price_date", dateKey)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load ETH price snapshot: ${error.message}`);
    }

    if (data) {
      return normalizeDailyPriceRow(data);
    }

    const latest = await this.getLatestEthPriceSnapshot();
    if (latest) {
      return {
        ...latest,
        price_date: dateKey,
        source: "fallback_cached",
        metadata: {
          ...(latest.metadata ?? {}),
          fallbackFromDate: latest.price_date,
          readOnly: true,
        },
      };
    }

    return {
      id: 0,
      asset_symbol: "ETH",
      price_date: dateKey,
      price_usd: DEFAULT_ETH_PRICE_USD,
      source: "fallback_default",
      metadata: {
        fallbackReason: "price_feed_unavailable",
        readOnly: true,
      },
    } satisfies DailyAssetPriceRecord;
  }

  private buildDefaultBalanceUser(address?: string) {
    return {
      address: address ? this.normalizeStoredAddress(address) : "",
      referral_code: "",
      total_points: 0,
      current_streak: 0,
      longest_streak: 0,
      last_check_in: null,
      spin_tickets: 0,
    } satisfies Pick<
      UserRecord,
      | "address"
      | "referral_code"
      | "total_points"
      | "current_streak"
      | "longest_streak"
      | "last_check_in"
      | "spin_tickets"
    >;
  }

  private async buildDefaultBalance(address?: string) {
    const priceSnapshot = await this.getReadOnlyEthPriceSnapshot();

    return this.buildBalancePayload(this.buildDefaultBalanceUser(address), {
      rank: 0,
      priceSnapshot,
    });
  }

  private buildDefaultUserStats() {
    return {
      totalPoints: 0,
      dustSwept: 0,
      swapVolume: 0,
      tokensBurned: 0,
    };
  }

  private buildDefaultReferralStats() {
    return {
      code: "",
      friendsJoined: 0,
      pointsEarned: 0,
    };
  }

  private async buildDefaultPointsSummary(address?: string) {
    return {
      balance: {
        success: true,
        ...(await this.buildDefaultBalance(address)),
      },
      stats: {
        success: true,
        ...this.buildDefaultUserStats(),
      },
      referral: {
        success: true,
        ...this.buildDefaultReferralStats(),
        hasReferrer: false,
      },
    };
  }

  private async getExistingFootprintClaimByUserId(userId: number) {
    const { data, error } = await postgresDb
      .from("point_events")
      .select("id, points, total_awarded, metadata, created_at")
      .eq("user_id", userId)
      .eq("action", "footprint_airdrop_claim")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Load footprint claim event: ${error.message}`);
    }

    return (data as PointEventRow | null) ?? null;
  }

  private async hasReferralActivation(user: UserRecord) {
    if (user.last_check_in) {
      return true;
    }

    const existingClaim = await this.getExistingFootprintClaimByUserId(user.id);
    return Boolean(existingClaim);
  }

  private async getExistingPointEventByUserIdAndAction(userId: number, action: string) {
    const { data, error } = await postgresDb
      .from("point_events")
      .select("id, points, total_awarded, metadata, created_at")
      .eq("user_id", userId)
      .eq("action", action)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Load point event by action: ${error.message}`);
    }

    return (data as PointEventRow | null) ?? null;
  }

  private async getReferralSignupEventByRefereeId(referrerId: number, refereeId: number) {
    const { data, error } = await postgresDb
      .from("point_events")
      .select("id, points, total_awarded, metadata, created_at")
      .eq("user_id", referrerId)
      .eq("action", "referral_new_user")
      .contains("metadata", { refereeId })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Load referral signup event: ${error.message}`);
    }

    return (data as PointEventRow | null) ?? null;
  }

  private async getReferralLedgerByRefereeId(refereeId: number) {
    const { data, error } = await postgresDb
      .from("referrals")
      .select("referrer_id, referee_id, referrer_earned, referee_first_sweep, created_at")
      .eq("referee_id", refereeId)
      .maybeSingle();

    if (error) {
      throw new Error(`Load referral ledger: ${error.message}`);
    }

    return (
      data as
        | {
            referrer_id: number;
            referee_id: number;
            referrer_earned: number | string | null;
            referee_first_sweep: boolean | null;
            created_at?: string | null;
          }
        | null
    ) ?? null;
  }

  private normalizeFootprintClaim(
    address: string,
    event: PointEventRow
  ): FootprintLookupResult & {
    claimed: boolean;
    claimable: boolean;
    claimedAt: string | null;
  } {
    const metadata =
      event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
        ? event.metadata
        : {};

    const toNumberOrNull = (value: unknown) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };

    const source =
      metadata.sourceKind === "saved_leaderboard" || metadata.sourceKind === "blockscout"
        ? (metadata.sourceKind as FootprintLookupSource)
        : null;

    return {
      address,
      claimed: true,
      claimable: false,
      eligible: true,
      rewardPoints: Number(event.total_awarded || event.points || 0),
      source,
      rangeMin: toNumberOrNull(metadata.rangeMin),
      rangeMax: toNumberOrNull(metadata.rangeMax),
      tierLabel: typeof metadata.tierLabel === "string" ? metadata.tierLabel : null,
      reason: null,
      allowlistTotalUsdc: toNumberOrNull(metadata.allowlistTotalUsdc),
      transactionsCount: toNumberOrNull(metadata.transactionsCount),
      tokenTransfersCount: toNumberOrNull(metadata.tokenTransfersCount),
      totalActivity: toNumberOrNull(metadata.totalActivity),
      claimedAt: event.created_at || null,
    };
  }

  private async getPointsOverview() {
    const { count, error: countError } = await postgresDb
      .from("users")
      .select("id", { count: "exact", head: true })
      .or(LEADERBOARD_FALLBACK_USER_FILTER);

    if (countError) {
      throw new Error(`Load points overview count: ${countError.message}`);
    }

    const { data, error } = await postgresDb.rpc("get_points_overview");
    if (error && !this.isMissingRpcFunctionError(error, "get_points_overview")) {
      throw new Error(`Load points overview: ${error.message}`);
    }

    const row = firstRow(data as PointsOverviewRow[] | null);
    const totalParticlePoints =
      row && !error
        ? Number(row.total_particle_points || 0)
        : await this.getFallbackTotalParticlePoints();

    return {
      totalParticlePoints,
      totalUserCount: Number(count || 0),
    };
  }

  private async getParticlePointLeaderboardPage(offset: number, limit: number) {
    const { data, error } = await postgresDb.rpc("get_particle_point_leaderboard_page", {
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      if (this.isMissingRpcFunctionError(error, "get_particle_point_leaderboard_page")) {
        return this.getFallbackParticlePointLeaderboardPage(offset, limit);
      }

      throw new Error(`Load particle point leaderboard: ${error.message}`);
    }

    return ((data ?? []) as ParticlePointLeaderboardRow[]).map((row) => ({
      rank: Number(row.rank || 0),
      userId: Number(row.user_id || 0),
      address: String(row.address),
      totalPoints: Number(row.total_points || 0),
      currentStreak: Number(row.current_streak || 0),
      lastCheckIn: row.last_check_in || null,
    })) satisfies ParticlePointLeaderboardEntryRow[];
  }

  private async getParticlePointLeaderboardViewer(userId: number) {
    const { data, error } = await postgresDb.rpc("get_particle_point_leaderboard_viewer", {
      p_user_id: userId,
    });

    if (error) {
      if (this.isMissingRpcFunctionError(error, "get_particle_point_leaderboard_viewer")) {
        return this.getFallbackParticlePointLeaderboardViewer(userId);
      }

      throw new Error(`Load particle point leaderboard viewer: ${error.message}`);
    }

    const row = firstRow(data as ParticlePointLeaderboardRow[] | null);
    if (!row) {
      return null;
    }

    return {
      rank: Number(row.rank || 0),
      userId: Number(row.user_id || 0),
      address: String(row.address),
      totalPoints: Number(row.total_points || 0),
      currentStreak: Number(row.current_streak || 0),
      lastCheckIn: row.last_check_in || null,
    } satisfies ParticlePointLeaderboardEntryRow;
  }

  private isMissingRpcFunctionError(
    errorLike?:
      | {
          code?: string;
          message?: string | null;
          details?: string | null;
          hint?: string | null;
        }
      | string
      | null,
    functionName?: string
  ) {
    const code = typeof errorLike === "string" ? undefined : errorLike?.code;
    const normalized = String(
      typeof errorLike === "string"
        ? errorLike
        : `${errorLike?.message || ""} ${errorLike?.details || ""} ${errorLike?.hint || ""}`
    ).toLowerCase();

    if (functionName && !normalized.includes(functionName.toLowerCase())) {
      return false;
    }

    return (
      code === "42883" ||
      normalized.includes("undefined function") ||
      (normalized.includes("function public.") && normalized.includes("does not exist")) ||
      (normalized.includes("could not find the function public.") &&
        normalized.includes("schema cache"))
    );
  }

  private isStatementTimeoutError(message?: string | null) {
    return String(message || "").toLowerCase().includes("statement timeout");
  }

  private isMissingRelationError(error: { code?: string; message?: string } | null) {
    if (!error) {
      return false;
    }

    return error.code === "42P01" || error.code === "PGRST205";
  }

  private isReferralLeaderboardSnapshotStale(meta: ReferralLeaderboardSnapshotMetaRow | null) {
    if (!meta?.refreshed_at) {
      return true;
    }

    const refreshedAt = Date.parse(meta.refreshed_at);
    if (!Number.isFinite(refreshedAt)) {
      return true;
    }

    return Date.now() - refreshedAt >= REFERRAL_LEADERBOARD_SNAPSHOT_TTL_MS;
  }

  private async getReferralLeaderboardSnapshotMeta() {
    const { data, error } = await postgresDb
      .from("referral_leaderboard_snapshot_meta")
      .select("refreshed_at, total_entries")
      .eq("singleton", 1)
      .maybeSingle();

    if (error) {
      if (this.isMissingRelationError(error)) {
        return null;
      }

      throw new Error(`Load referral leaderboard snapshot meta: ${error.message}`);
    }

    return (data as ReferralLeaderboardSnapshotMetaRow | null) ?? null;
  }

  private async refreshReferralLeaderboardSnapshot() {
    const { data, error } = await postgresDb.rpc("refresh_referral_leaderboard_snapshot");

    if (error) {
      if (
        this.isMissingRpcFunctionError(error, "refresh_referral_leaderboard_snapshot") ||
        this.isMissingRelationError(error)
      ) {
        return null;
      }

      throw new Error(`Refresh referral leaderboard snapshot: ${error.message}`);
    }

    const row = firstRow(data as ReferralLeaderboardSnapshotMetaRow[] | null);
    if (!row) {
      return null;
    }

    return {
      refreshed_at: row.refreshed_at || new Date().toISOString(),
      total_entries: Number(row.total_entries || 0),
    } satisfies ReferralLeaderboardSnapshotMetaRow;
  }

  private async ensureReferralLeaderboardSnapshot() {
    let meta: ReferralLeaderboardSnapshotMetaRow | null = null;

    try {
      meta = await this.getReferralLeaderboardSnapshotMeta();
    } catch (error) {
      console.error("[Referral Leaderboard Snapshot] Failed to load snapshot meta", error);
      return null;
    }

    const refreshKey = "leaderboard:referral:snapshot-refresh";

    if (!meta) {
      try {
        return await runtimeCache.singleFlight(refreshKey, async () => {
          return this.refreshReferralLeaderboardSnapshot();
        });
      } catch (error) {
        console.error("[Referral Leaderboard Snapshot] Initial refresh failed", error);
        return null;
      }
    }

    if (this.isReferralLeaderboardSnapshotStale(meta)) {
      void runtimeCache
        .singleFlight(refreshKey, async () => {
          return this.refreshReferralLeaderboardSnapshot();
        })
        .catch((error) => {
          console.error("[Referral Leaderboard Snapshot] Background refresh failed", error);
        });
    }

    return meta;
  }

  private async getReferralLeaderboardSnapshotPage(offset: number, limit: number) {
    const { data, error } = await postgresDb
      .from("referral_leaderboard_snapshot_entries")
      .select("rank, user_id, address, total_points, referral_points, referred_users")
      .order("rank", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      if (this.isMissingRelationError(error)) {
        return null;
      }

      throw new Error(`Load referral leaderboard snapshot page: ${error.message}`);
    }

    return ((data ?? []) as ReferralLeaderboardRow[])
      .map((row) => ({
        rank: Number(row.rank || 0),
        userId: Number(row.user_id || 0),
        address: String(row.address),
        totalPoints: Number(row.total_points || 0),
        referralPoints: Number(row.referral_points || 0),
        referredUsers: Number(row.referred_users || 0),
        swapVolume: 0,
      }))
      .filter((entry) => entry.referredUsers > 0);
  }

  private async getReferralLeaderboardSnapshotViewer(userId: number) {
    const { data, error } = await postgresDb
      .from("referral_leaderboard_snapshot_entries")
      .select("rank, user_id, address, total_points, referral_points, referred_users")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      if (this.isMissingRelationError(error)) {
        return null;
      }

      throw new Error(`Load referral leaderboard snapshot viewer: ${error.message}`);
    }

    const row = (data as ReferralLeaderboardRow | null) ?? null;
    if (!row) {
      return null;
    }

    return {
      rank: Number(row.rank || 0),
      userId: Number(row.user_id || 0),
      address: String(row.address),
      totalPoints: Number(row.total_points || 0),
      referralPoints: Number(row.referral_points || 0),
      referredUsers: Number(row.referred_users || 0),
      swapVolume: 0,
    } satisfies Omit<LeaderboardEntry, "profile">;
  }

  private isFallbackLeaderboardEligibleUser(user: {
    current_streak?: number | string | null;
    last_check_in?: string | null;
    spin_tickets?: number | string | null;
    total_points?: number | string | null;
  }) {
    return (
      Number(user.total_points || 0) > 0 ||
      Number(user.current_streak || 0) > 0 ||
      Number(user.spin_tickets || 0) > 0 ||
      Boolean(user.last_check_in)
    );
  }

  private async getFallbackTotalParticlePoints() {
    const pointRows = await this.fetchAllPages<Pick<UserRecord, "total_points">>(
      async (from, to) =>
        postgresDb
          .from("users")
          .select("total_points")
          .gt("total_points", 0)
          .range(from, to)
    );

    return pointRows.reduce(
      (sum, row) => sum + Math.max(0, Number((row as { total_points?: number | string | null }).total_points || 0)),
      0
    );
  }

  private async getFallbackParticlePointLeaderboardPage(offset: number, limit: number) {
    const { data, error } = await postgresDb
      .from("users")
      .select("id, address, total_points, current_streak, last_check_in, spin_tickets")
      .or(LEADERBOARD_FALLBACK_USER_FILTER)
      .order("total_points", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Load particle point leaderboard fallback: ${error.message}`);
    }

    return ((data ?? []) as ParticlePointFallbackUserRow[]).map((row, index) => ({
      rank: offset + index + 1,
      userId: Number(row.id || 0),
      address: String(row.address),
      totalPoints: Number(row.total_points || 0),
      currentStreak: Number(row.current_streak || 0),
      lastCheckIn: row.last_check_in || null,
    })) satisfies ParticlePointLeaderboardEntryRow[];
  }

  private async getFallbackParticlePointLeaderboardViewer(userId: number) {
    const { data: userData, error: userError } = await postgresDb
      .from("users")
      .select("id, address, total_points, current_streak, last_check_in, spin_tickets")
      .eq("id", userId)
      .maybeSingle();

    if (userError) {
      throw new Error(`Load particle point leaderboard viewer fallback: ${userError.message}`);
    }

    const user = (userData as ParticlePointFallbackUserRow | null) ?? null;
    if (!user || !this.isFallbackLeaderboardEligibleUser(user)) {
      return null;
    }

    const { count, error: rankError } = await postgresDb
      .from("users")
      .select("id", { count: "exact", head: true })
      .or(LEADERBOARD_FALLBACK_USER_FILTER)
      .gt("total_points", Number(user.total_points || 0));

    if (rankError) {
      throw new Error(`Load particle point leaderboard viewer fallback rank: ${rankError.message}`);
    }

    return {
      rank: Number(count || 0) + 1,
      userId: Number(user.id || 0),
      address: String(user.address),
      totalPoints: Number(user.total_points || 0),
      currentStreak: Number(user.current_streak || 0),
      lastCheckIn: user.last_check_in || null,
    } satisfies ParticlePointLeaderboardEntryRow;
  }

  private async getFallbackReferralLeaderboardEntries() {
    const referralRows = await this.fetchAllPages<ReferralReferrerRow>(
      async (from, to) =>
        postgresDb
          .from("referrals")
          .select("referrer_id")
          .not("referrer_id", "is", null)
          .range(from, to)
    );

    const referredUsersByUserId = new Map<number, number>();
    for (const row of referralRows) {
      const userId = Number(row.referrer_id || 0);
      if (userId > 0) {
        referredUsersByUserId.set(
          userId,
          (referredUsersByUserId.get(userId) || 0) + 1
        );
      }
    }

    const userIds = [...referredUsersByUserId.keys()];
    if (!userIds.length) {
      return [] satisfies Array<Omit<LeaderboardEntry, "profile">>;
    }

    const [users, referralPointRows] = await Promise.all([
      this.fetchUsersByIds(userIds),
      this.fetchAllPages<ReferralPointEventRow>(
        async (from, to) =>
          postgresDb
            .from("point_events")
            .select("user_id, total_awarded")
            .in("action", ["referral_commission", "referral_new_user"])
            .range(from, to)
      ),
    ]);

    const referralUserIdSet = new Set(userIds);
    const referralPointsByUserId = new Map<number, number>();
    for (const row of referralPointRows) {
      const userId = Number(row.user_id || 0);
      if (!referralUserIdSet.has(userId)) {
        continue;
      }

      referralPointsByUserId.set(
        userId,
        (referralPointsByUserId.get(userId) || 0) +
          Math.max(0, Number(row.total_awarded || 0))
      );
    }

    return userIds
      .map((userId) => {
        const user = users.get(userId);
        if (!user) {
          return null;
        }

        return {
          rank: 0,
          userId,
          address: user.address,
          totalPoints: Number(user.total_points || 0),
          referralPoints: referralPointsByUserId.get(userId) || 0,
          referredUsers: referredUsersByUserId.get(userId) || 0,
          swapVolume: 0,
        };
      })
      .filter((entry): entry is Omit<LeaderboardEntry, "profile"> => {
        return Boolean(entry && entry.referredUsers > 0);
      })
      .sort((a, b) => {
        return (
          b.referralPoints - a.referralPoints ||
          b.referredUsers - a.referredUsers ||
          b.totalPoints - a.totalPoints ||
          a.userId - b.userId
        );
      })
      .map((entry, index) => ({
        ...entry,
        rank: index + 1,
      }));
  }

  private async getFallbackReferralLeaderboardPage(offset: number, limit: number) {
    const entries = await this.getFallbackReferralLeaderboardEntries();
    return entries.slice(offset, offset + limit);
  }

  private async getFallbackReferralLeaderboardCount() {
    const entries = await this.getFallbackReferralLeaderboardEntries();
    return entries.length;
  }

  private async getFallbackReferralLeaderboardViewer(userId: number) {
    const entries = await this.getFallbackReferralLeaderboardEntries();
    return entries.find((entry) => entry.userId === userId) ?? null;
  }

  private async getLiveReferralLeaderboardPage(offset: number, limit: number) {
    const { data, error } = await postgresDb.rpc("get_referral_leaderboard_page", {
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      if (
        this.isMissingRpcFunctionError(error, "get_referral_leaderboard_page") ||
        this.isStatementTimeoutError(error.message)
      ) {
        return this.getFallbackReferralLeaderboardPage(offset, limit);
      }

      throw new Error(`Load referral leaderboard: ${error.message}`);
    }

    return ((data ?? []) as ReferralLeaderboardRow[])
      .map((row) => ({
        rank: Number(row.rank || 0),
        userId: Number(row.user_id || 0),
        address: String(row.address),
        totalPoints: Number(row.total_points || 0),
        referralPoints: Number(row.referral_points || 0),
        referredUsers: Number(row.referred_users || 0),
        swapVolume: 0,
      }))
      .filter((entry) => entry.referredUsers > 0);
  }

  private async getLiveReferralLeaderboardCount() {
    const { data, error } = await postgresDb.rpc("get_referral_leaderboard_count");

    if (error) {
      if (
        this.isMissingRpcFunctionError(error, "get_referral_leaderboard_count") ||
        this.isStatementTimeoutError(error.message)
      ) {
        return this.getFallbackReferralLeaderboardCount();
      }

      throw new Error(`Load referral leaderboard count: ${error.message}`);
    }

    const row = firstRow(data as ReferralLeaderboardCountRow[] | null);
    return Number(row?.total_entries || 0);
  }

  private async getLiveReferralLeaderboardViewer(userId: number) {
    const { data, error } = await postgresDb.rpc("get_referral_leaderboard_viewer", {
      p_user_id: userId,
    });

    if (error) {
      if (
        this.isMissingRpcFunctionError(error, "get_referral_leaderboard_viewer") ||
        this.isStatementTimeoutError(error.message)
      ) {
        return this.getFallbackReferralLeaderboardViewer(userId);
      }

      throw new Error(`Load referral leaderboard viewer: ${error.message}`);
    }

    const row = firstRow(data as ReferralLeaderboardRow[] | null);
    if (!row) {
      return null;
    }

    const referredUsers = Number(row.referred_users || 0);
    if (referredUsers < 1) {
      return null;
    }

    return {
      rank: Number(row.rank || 0),
      userId: Number(row.user_id || 0),
      address: String(row.address),
      totalPoints: Number(row.total_points || 0),
      referralPoints: Number(row.referral_points || 0),
      referredUsers,
      swapVolume: 0,
    } satisfies Omit<LeaderboardEntry, "profile">;
  }

  private async getVolumeLeaderboardPage(offset: number, limit: number) {
    const { data, error } = await postgresDb.rpc("get_volume_leaderboard_page", {
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      throw new Error(`Load volume leaderboard: ${error.message}`);
    }

    return ((data ?? []) as VolumeLeaderboardRow[]).map((row) => ({
      rank: Number(row.rank || 0),
      userId: Number(row.user_id || 0),
      address: String(row.address),
      totalPoints: Number(row.total_points || 0),
      referralPoints: 0,
      referredUsers: 0,
      swapVolume: Number(row.swap_volume || 0),
    }));
  }

  private async getVolumeLeaderboardViewer(userId: number) {
    const { data, error } = await postgresDb.rpc("get_volume_leaderboard_viewer", {
      p_user_id: userId,
    });

    if (error) {
      throw new Error(`Load volume leaderboard viewer: ${error.message}`);
    }

    const row = firstRow(data as VolumeLeaderboardRow[] | null);
    if (!row) {
      return null;
    }

    return {
      rank: Number(row.rank || 0),
      userId: Number(row.user_id || 0),
      address: String(row.address),
      totalPoints: Number(row.total_points || 0),
      referralPoints: 0,
      referredUsers: 0,
      swapVolume: Number(row.swap_volume || 0),
    } satisfies Omit<LeaderboardEntry, "profile">;
  }

  private async buildParticlePointsViewerEntry(viewerAddress?: string) {
    if (!viewerAddress) {
      return null;
    }

    const user = await this.findExistingUser(viewerAddress);
    if (!user) {
      return null;
    }

    const [profiles, userStats, referralStats, viewerRow] = await Promise.all([
      this.fetchCachedProfiles([user.id]),
      this.getSweepStatsByUserId(user.id),
      this.getReferralStatsByUserId(user.id),
      this.getParticlePointLeaderboardViewer(user.id),
    ]);

    if (!viewerRow) {
      return null;
    }

    return {
      rank: viewerRow.rank,
      userId: user.id,
      address: user.address,
      totalPoints: Number(user.total_points || 0),
      referralPoints: referralStats.pointsEarned,
      referredUsers: referralStats.friendsJoined,
      swapVolume: userStats.swapVolume,
      profile: profiles.get(user.id) ?? null,
    } satisfies LeaderboardEntry;
  }

  async cacheFarcasterProfile(
    address: string,
    profile: {
      fid: string;
      username?: string | null;
      displayName?: string | null;
      pfpUrl?: string | null;
    }
  ) {
    const user = await this.findExistingUser(address);
    if (!user) {
      return;
    }

    const { error } = await postgresDb
      .from("social_accounts")
      .upsert(
        {
          user_id: user.id,
          platform: "farcaster",
          platform_user_id: profile.fid,
          username: profile.username || null,
          display_name: profile.displayName || null,
          profile_image_url: profile.pfpUrl || null,
          metadata: {
            source: "neynar",
            cachedAt: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "user_id,platform",
        }
      );

    if (error) {
      throw new Error(`Save Farcaster profile: ${error.message}`);
    }

    this.invalidateLeaderboardCache();
  }

  private async updateReferralLedger(
    referrerId: number,
    refereeId: number,
    pointsAwarded: number,
    options?: { markFirstSweep?: boolean }
  ) {
    const safePointsAwarded = Math.max(0, Number(pointsAwarded || 0));
    const shouldMarkFirstSweep = Boolean(options?.markFirstSweep);

    const { error: ensureError } = await postgresDb.from("referrals").upsert(
      {
        referrer_id: referrerId,
        referee_id: refereeId,
        referrer_earned: 0,
        referee_first_sweep: false,
      },
      {
        onConflict: "referee_id",
        ignoreDuplicates: true,
      }
    );

    if (ensureError) {
      throw new Error(`Ensure referral ledger: ${ensureError.message}`);
    }

    for (let attempt = 0; attempt < REFERRAL_LEDGER_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      const { data: existingReferral, error: loadError } = await postgresDb
        .from("referrals")
        .select("id, referrer_id, referrer_earned, referee_first_sweep")
        .eq("referee_id", refereeId)
        .maybeSingle();

      if (loadError) {
        throw new Error(`Load referral ledger: ${loadError.message}`);
      }

      if (!existingReferral) {
        continue;
      }

      if (Number(existingReferral.referrer_id) !== referrerId) {
        throw new Error("Referral ledger mismatch");
      }

      const currentEarned = Number(existingReferral.referrer_earned || 0);
      const currentFirstSweep = Boolean(existingReferral.referee_first_sweep);
      const nextEarned = currentEarned + safePointsAwarded;
      const nextFirstSweep = currentFirstSweep || shouldMarkFirstSweep;

      if (nextEarned === currentEarned && nextFirstSweep === currentFirstSweep) {
        return;
      }

      const { data: updatedReferral, error: updateError } = await postgresDb
        .from("referrals")
        .update({
          referrer_earned: nextEarned,
          referee_first_sweep: nextFirstSweep,
        })
        .eq("referee_id", refereeId)
        .eq("referrer_id", referrerId)
        .eq("referrer_earned", currentEarned)
        .eq("referee_first_sweep", currentFirstSweep)
        .select("id")
        .maybeSingle();

      if (updateError) {
        throw new Error(`Update referral ledger: ${updateError.message}`);
      }

      if (updatedReferral) {
        return;
      }
    }

    throw new Error("Update referral ledger: concurrent update retry exhausted");
  }

  private async ensureReferralSignupLedgerBaseline(
    referrerId: number,
    refereeId: number,
    minimumEarned: number
  ) {
    const safeMinimum = Math.max(0, Number(minimumEarned || 0));
    if (safeMinimum <= 0) {
      return;
    }

    const { error: ensureError } = await postgresDb.from("referrals").upsert(
      {
        referrer_id: referrerId,
        referee_id: refereeId,
        referrer_earned: 0,
        referee_first_sweep: false,
      },
      {
        onConflict: "referee_id",
        ignoreDuplicates: true,
      }
    );

    if (ensureError) {
      throw new Error(`Ensure referral ledger: ${ensureError.message}`);
    }

    for (let attempt = 0; attempt < REFERRAL_LEDGER_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      const { data: existingReferral, error: loadError } = await postgresDb
        .from("referrals")
        .select("referrer_id, referrer_earned")
        .eq("referee_id", refereeId)
        .maybeSingle();

      if (loadError) {
        throw new Error(`Load referral ledger: ${loadError.message}`);
      }

      if (!existingReferral) {
        continue;
      }

      if (Number(existingReferral.referrer_id) !== referrerId) {
        throw new Error("Referral ledger mismatch");
      }

      const currentEarned = Number(existingReferral.referrer_earned || 0);
      if (currentEarned >= safeMinimum) {
        return;
      }

      const { data: updatedReferral, error: updateError } = await postgresDb
        .from("referrals")
        .update({
          referrer_earned: safeMinimum,
        })
        .eq("referee_id", refereeId)
        .eq("referrer_id", referrerId)
        .eq("referrer_earned", currentEarned)
        .select("id")
        .maybeSingle();

      if (updateError) {
        throw new Error(`Repair referral ledger: ${updateError.message}`);
      }

      if (updatedReferral) {
        return;
      }
    }

    throw new Error("Repair referral ledger: concurrent update retry exhausted");
  }

  private async finalizeReferralLink(
    user: Pick<UserRecord, "id" | "address">,
    referrer: Pick<UserRecord, "id" | "address">,
    normalizedCode: string
  ) {
    const { error: ledgerError } = await postgresDb.from("referrals").upsert(
      {
        referrer_id: referrer.id,
        referee_id: user.id,
        referrer_earned: 0,
        referee_first_sweep: false,
      },
      {
        onConflict: "referee_id",
        ignoreDuplicates: true,
      }
    );

    if (ledgerError) {
      throw new Error(`Ensure referral ledger: ${ledgerError.message}`);
    }

    const welcomeEvent = await this.getExistingPointEventByUserIdAndAction(
      user.id,
      "referral_welcome"
    );

    if (!welcomeEvent) {
      await this.addPoints(
        user.address,
        CFG.REFERRAL_SIGNUP,
        "referral_welcome",
        undefined,
        {
          referralCode: normalizedCode,
          referrerId: referrer.id,
          referrerAddress: referrer.address,
        },
        { applyStreakBoost: false }
      );
    }

    const referralSignupEvent = await this.getReferralSignupEventByRefereeId(
      referrer.id,
      user.id
    );

    if (referralSignupEvent) {
      await this.ensureReferralSignupLedgerBaseline(
        referrer.id,
        user.id,
        Number(referralSignupEvent.total_awarded || referralSignupEvent.points || 0)
      );
    } else {
      const referrerAward = await this.addPoints(
        referrer.address,
        CFG.REFERRAL_SIGNUP,
        "referral_new_user",
        undefined,
        {
          referralCode: normalizedCode,
          refereeId: user.id,
          refereeAddress: user.address,
        },
        { applyStreakBoost: false }
      );

      await this.updateReferralLedger(
        referrer.id,
        user.id,
        referrerAward.totalAwarded
      );
    }

    this.invalidateUserReadCaches(user.address);
    this.invalidateUserReadCaches(referrer.address);

    return {
      applied: true,
      message: "Referral applied!",
    } satisfies ReferralApplyResult;
  }

  private getAppliedReferralResult() {
    return {
      applied: true,
      message: "Referral applied!",
    } satisfies ReferralApplyResult;
  }

  private async awardReferralCommission(
    sourceUser: UserRecord,
    sourceAddress: string,
    sourceAction: string,
    sourcePointsAwarded: number,
    txHash?: string
  ) {
    if (
      !sourceUser.referred_by ||
      sourcePointsAwarded <= 0 ||
      !isReferralCommissionEligibleAction(sourceAction)
    ) {
      return 0;
    }

    const { data: referrer } = await postgresDb
      .from("users")
      .select("id, address")
      .eq("id", sourceUser.referred_by)
      .maybeSingle();

    if (!referrer) {
      return 0;
    }

    const commissionBasePoints = Math.floor(
      (sourcePointsAwarded * CFG.REFERRAL_COMMISSION_PCT) / 100
    );

    if (commissionBasePoints <= 0) {
      return 0;
    }

    const referralAward = await this.addPoints(
      String((referrer as { address: string }).address),
      commissionBasePoints,
      "referral_commission",
      txHash,
      {
        sourceAction,
        sourceAddress: sourceAddress.toLowerCase(),
        sourcePointsAwarded,
        commissionPct: CFG.REFERRAL_COMMISSION_PCT,
        founderPassContract: REFERRAL_FOUNDER_PASS_CONTRACT || null,
        founderPassBonusPct: REFERRAL_FOUNDER_PASS_BONUS_PCT,
        cofounderPassContract: REFERRAL_COFOUNDER_PASS_CONTRACT || null,
        cofounderPassBonusPct: REFERRAL_COFOUNDER_PASS_BONUS_PCT,
      },
      { applyStreakBoost: false }
    );

    await this.updateReferralLedger(
      Number((referrer as { id: number }).id),
      sourceUser.id,
      referralAward.totalAwarded,
      {
        markFirstSweep: sourceAction === "dust_sweep",
      }
    );

    return referralAward.totalAwarded;
  }

  private async addPoints(
    address: string,
    pts: number,
    action: string,
    txHash?: string,
    meta?: unknown,
    options?: AddPointsOptions
  ) {
    const user = await this.getOrCreate(address);
    const snapshot = buildStreakSnapshot(user);
    const applyStreakBoost = options?.applyStreakBoost ?? isBoostEligibleAction(action);
    const boostPercent = applyStreakBoost ? snapshot.boostPercent : 0;
    const multiplier = 1 + boostPercent / 100;
    const totalAwarded = Math.max(0, Math.floor(pts * multiplier));

    await postgresDb.from("point_events").insert({
      user_id: user.id,
      action,
      points: pts,
      multiplier,
      total_awarded: totalAwarded,
      tx_hash: txHash,
      metadata: safeMetadata(meta, {
        boostPercent,
        streakAtAward: snapshot.activeStreak,
        boostApplied: applyStreakBoost,
      }),
      season: 1,
    });

    await postgresDb
      .from("users")
      .update({
        total_points: user.total_points + totalAwarded,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (options?.applyReferralCommission !== false) {
      await this.awardReferralCommission(user, address, action, totalAwarded, txHash);
    }

    this.invalidateUserReadCaches(address);

    return {
      user: {
        ...user,
        total_points: user.total_points + totalAwarded,
      } as UserRecord,
      basePoints: pts,
      totalAwarded,
      boostPercent,
      multiplier,
    };
  }

  async awardCustomPoints(
    address: string,
    pts: number,
    action: string,
    meta?: unknown,
    txHash?: string
  ): Promise<number> {
    if (pts <= 0) {
      return 0;
    }

    const result = await this.addPoints(address, pts, action, txHash, meta);
    return result.totalAwarded;
  }

  async awardAdminPointsBatch(args: {
    entries: AdminPointGrantInput[];
    note?: string;
    requestId?: string;
    source?: string;
  }) {
    const note = typeof args.note === "string" ? args.note.trim() : "";
    const requestId = String(args.requestId || "").trim();
    const source = String(args.source || "quest_admin_console").trim() || "quest_admin_console";
    const rawEntries = Array.isArray(args.entries) ? args.entries : [];

    if (!requestId) {
      throw new Error("requestId is required");
    }

    if (rawEntries.length === 0) {
      throw new Error("At least one wallet is required");
    }

    if (rawEntries.length > ADMIN_POINT_GRANT_MAX_BATCH_SIZE) {
      throw new Error(
        `A single batch can include up to ${ADMIN_POINT_GRANT_MAX_BATCH_SIZE} wallets`
      );
    }

    const seenAddresses = new Set<string>();
    const entries = rawEntries.map((entry, index) => {
      const normalizedAddress = getAddress(String(entry.address || "")).toLowerCase();
      const points = Number(entry.points);

      if (!Number.isInteger(points) || points <= 0) {
        throw new Error(`Wallet ${index + 1} must have a positive whole-number PP amount`);
      }

      if (seenAddresses.has(normalizedAddress)) {
        throw new Error(`Duplicate wallet in batch: ${normalizedAddress}`);
      }

      seenAddresses.add(normalizedAddress);
      return {
        address: normalizedAddress,
        points,
      } satisfies AdminPointGrantInput;
    });

    const requestSignature = buildAdminPointGrantSignature(entries, note);
    const totalRequestedPoints = entries.reduce((sum, entry) => sum + entry.points, 0);
    const { data: existingEvents, error: existingEventsError } = await postgresDb
      .from("point_events")
      .select("user_id, points, total_awarded, metadata, created_at")
      .eq("action", ADMIN_POINT_GRANT_ACTION)
      .contains("metadata", { requestId });

    if (existingEventsError) {
      throw new Error(`Load existing admin grant batch: ${existingEventsError.message}`);
    }

    const existingByUserId = new Map<number, AdminPointGrantEventRow>();
    for (const row of (existingEvents ?? []) as AdminPointGrantEventRow[]) {
      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? row.metadata
          : {};

      if (
        metadata.requestSignature &&
        String(metadata.requestSignature) !== requestSignature
      ) {
        throw new Error(
          "This grant batch was already used for a different wallet list. Refresh the page and try again."
        );
      }

      const userId = Number(row.user_id || 0);
      if (userId > 0 && !existingByUserId.has(userId)) {
        existingByUserId.set(userId, row);
      }
    }

    const grants: AdminPointGrantResult[] = [];

    for (const entry of entries) {
      const user = await this.getOrCreate(entry.address);
      const existingGrant = existingByUserId.get(user.id);

      if (existingGrant) {
        grants.push({
          address: entry.address,
          userId: user.id,
          requestedPoints: entry.points,
          totalAwarded: Number(
            existingGrant.total_awarded || existingGrant.points || entry.points
          ),
          totalPoints: Number(user.total_points || 0),
          createdAt: existingGrant.created_at || null,
          idempotent: true,
        });
        continue;
      }

      const award = await this.addPoints(
        entry.address,
        entry.points,
        ADMIN_POINT_GRANT_ACTION,
        undefined,
        {
          note: note || null,
          requestId,
          requestSignature,
          requestedPoints: entry.points,
          source,
          batchSize: entries.length,
          totalRequestedPoints,
        },
        {
          applyStreakBoost: false,
          applyReferralCommission: false,
        }
      );

      grants.push({
        address: entry.address,
        userId: award.user.id,
        requestedPoints: entry.points,
        totalAwarded: award.totalAwarded,
        totalPoints: Number(award.user.total_points || 0),
        createdAt: new Date().toISOString(),
        idempotent: false,
      });
    }

    return {
      requestId,
      recipientCount: grants.length,
      grantedCount: grants.filter((grant) => !grant.idempotent).length,
      reusedCount: grants.filter((grant) => grant.idempotent).length,
      totalRequestedPoints,
      totalAwardedPoints: grants.reduce((sum, grant) => sum + grant.totalAwarded, 0),
      grants,
    };
  }

  async awardOneTimeCampaignPoints(args: {
    address: string;
    points: number;
    action: string;
    metadata?: unknown;
    txHash?: string;
  }) {
    const normalizedAddress = getAddress(args.address).toLowerCase();
    const user = await this.getOrCreate(normalizedAddress);
    const existingEvent = await this.getExistingPointEventByUserIdAndAction(
      user.id,
      args.action
    );

    if (existingEvent) {
      return {
        alreadyAwarded: true,
        awardedAt: existingEvent.created_at || null,
        totalAwarded: Number(existingEvent.total_awarded || existingEvent.points || 0),
        user,
      };
    }

    const award = await this.addPoints(
      normalizedAddress,
      args.points,
      args.action,
      args.txHash,
      args.metadata,
      {
        applyStreakBoost: false,
        applyReferralCommission: false,
      }
    );

    return {
      alreadyAwarded: false,
      awardedAt: new Date().toISOString(),
      totalAwarded: award.totalAwarded,
      user: award.user,
    };
  }

  private async todayBasePoints(address: string, action: string): Promise<number> {
    const user = await this.getOrCreate(address);
    const start = getUtcStartOfDay();
    const { data } = await postgresDb
      .from("point_events")
      .select("points")
      .eq("user_id", user.id)
      .eq("action", action)
      .gte("created_at", start.toISOString());

    return (data ?? []).reduce(
      (sum: number, row: { points: number }) => sum + Number(row.points || 0),
      0
    );
  }

  private async verifyBasePayPayment(
    normalizedAddress: string,
    paymentId: string,
    usdTarget: number,
    priceSnapshot: DailyAssetPriceRecord,
    recipientAddress: string
  ): Promise<VerifiedPayment> {
    const status = await getPaymentStatus({
      id: paymentId,
      testnet: false,
      telemetry: false,
    });

    if (status.status !== "completed") {
      throw new Error(status.message || "Base Pay payment is not completed");
    }

    if (!status.sender || status.sender.toLowerCase() !== normalizedAddress) {
      throw new Error("Base Pay sender does not match this wallet");
    }

    if (
      !status.recipient ||
      status.recipient.toLowerCase() !== recipientAddress.toLowerCase()
    ) {
      throw new Error("Base Pay recipient does not match the check-in wallet");
    }

    const amountUsd = parseUsdAmount(status.amount);
    if (!amountUsd || amountUsd + Number.EPSILON < usdTarget) {
      throw new Error("Base Pay amount is below the required amount");
    }

    return {
      asset: "usdc",
      amount: getUsdcUnitsForUsd(amountUsd).toString(),
      amountUsd,
      priceDate: priceSnapshot.price_date,
      ethPriceUsd: priceSnapshot.price_usd,
    };
  }

  private verifySmartWalletEthPayment(
    normalizedAddress: string,
    transaction: Awaited<ReturnType<typeof getBaseTransaction>>,
    requiredWei: bigint,
    recipientAddress: string
  ) {
    if (
      !transaction.to ||
      transaction.to.toLowerCase() !== ENTRY_POINT_V06_ADDRESS ||
      transaction.value > 0n ||
      !transaction.input ||
      transaction.input === "0x"
    ) {
      return null;
    }

    try {
      const decodedEntryPointCall = decodeFunctionData({
        abi: ENTRY_POINT_HANDLE_OPS_ABI,
        data: transaction.input,
      });

      if (decodedEntryPointCall.functionName !== "handleOps") {
        return null;
      }

      const matchingOperation = decodedEntryPointCall.args[0].find(
        (operation) => operation.sender.toLowerCase() === normalizedAddress
      );

      if (!matchingOperation) {
        return null;
      }

      const decodedWalletCall = decodeFunctionData({
        abi: SMART_WALLET_EXECUTION_ABI,
        data: matchingOperation.callData,
      });

      const calls =
        decodedWalletCall.functionName === "execute"
          ? [
              {
                target: decodedWalletCall.args[0],
                value: decodedWalletCall.args[1],
                data: decodedWalletCall.args[2],
              },
            ]
          : decodedWalletCall.args[0];

      const matchingCall = calls.find(
        (call) =>
          call.target.toLowerCase() === recipientAddress.toLowerCase() &&
          call.value >= requiredWei
      );

      if (!matchingCall) {
        throw new Error("Smart wallet ETH payment is below the required amount");
      }

      return {
        asset: "eth" as const,
        amount: matchingCall.value.toString(),
      };
    } catch {
      return null;
    }
  }

  private async verifyFeeTransaction(
    normalizedAddress: string,
    txHash: string,
    usdTarget: number,
    asset?: SaveAsset,
    target: PaymentVerificationTarget = {
      allowBasePay: true,
      recipient: STREAK_SAVE_RECIPIENT,
      usdcAddress: STREAK_SAVE_USDC_ADDRESS,
    }
  ): Promise<VerifiedPayment> {
    const priceSnapshot = await this.getDailyEthPriceSnapshot();
    const ethRequiredWei = calculateEthWeiFromUsd(usdTarget, priceSnapshot.price_usd);
    const usdcRequiredUnits = getUsdcUnitsForUsd(usdTarget);

    if (target.allowBasePay !== false && asset !== "eth") {
      try {
        return await this.verifyBasePayPayment(
          normalizedAddress,
          txHash,
          usdTarget,
          priceSnapshot,
          target.recipient
        );
      } catch {
        // Fall through to raw on-chain inspection for normal EOA/ERC-20 payments.
      }
    }

    const [transaction, receipt] = await Promise.all([
      getBaseTransaction(txHash as `0x${string}`),
      getBaseTransactionReceipt(txHash as `0x${string}`),
    ]);

    if (receipt.status !== "success") {
      throw new Error("Payment transaction is not confirmed");
    }

    if (asset === "usdc") {
      const result = this.verifyUsdcPayment(
        receipt.logs,
        normalizedAddress,
        usdcRequiredUnits,
        target.usdcAddress,
        target.recipient
      );

      return {
        ...result,
        amountUsd: usdTarget,
        priceDate: priceSnapshot.price_date,
        ethPriceUsd: priceSnapshot.price_usd,
      };
    }

    if (asset === "eth") {
      const smartWalletPayment = this.verifySmartWalletEthPayment(
        normalizedAddress,
        transaction,
        ethRequiredWei,
        target.recipient
      );

      if (smartWalletPayment) {
        return {
          ...smartWalletPayment,
          amountUsd: usdTarget,
          priceDate: priceSnapshot.price_date,
          ethPriceUsd: priceSnapshot.price_usd,
        };
      }

      if (transaction.from.toLowerCase() !== normalizedAddress) {
        throw new Error("Payment transaction sender does not match this wallet");
      }

      const result = this.verifyEthPayment(
        transaction.to,
        transaction.value,
        ethRequiredWei,
        target.recipient
      );

      return {
        ...result,
        amountUsd: usdTarget,
        priceDate: priceSnapshot.price_date,
        ethPriceUsd: priceSnapshot.price_usd,
      };
    }

    try {
      const usdcPayment = this.verifyUsdcPayment(
        receipt.logs,
        normalizedAddress,
        usdcRequiredUnits,
        target.usdcAddress,
        target.recipient
      );

      return {
        ...usdcPayment,
        amountUsd: usdTarget,
        priceDate: priceSnapshot.price_date,
        ethPriceUsd: priceSnapshot.price_usd,
      };
    } catch {
      const ethPayment = this.verifyEthPayment(
        transaction.to,
        transaction.value,
        ethRequiredWei,
        target.recipient
      );
      return {
        ...ethPayment,
        amountUsd: usdTarget,
        priceDate: priceSnapshot.price_date,
        ethPriceUsd: priceSnapshot.price_usd,
      };
    }
  }

  private verifyEthPayment(
    to: string | null,
    value: bigint,
    requiredWei: bigint,
    recipientAddress: string
  ) {
    if (!to || to.toLowerCase() !== recipientAddress.toLowerCase()) {
      throw new Error("ETH payment was not sent to the check-in wallet");
    }

    if (value < requiredWei) {
      throw new Error("ETH payment is below the required amount");
    }

    return {
      asset: "eth" as const,
      amount: value.toString(),
    };
  }

  private verifyUsdcPayment(
    logs: readonly any[],
    normalizedAddress: string,
    requiredAmount: bigint,
    usdcAddress: string,
    recipientAddress: string
  ) {
    for (const log of logs) {
      if (String(log.address).toLowerCase() !== usdcAddress.toLowerCase()) {
        continue;
      }

      try {
        const decoded = decodeEventLog({
          abi: erc20Abi,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== "Transfer") {
          continue;
        }

        const from = String(decoded.args.from || "").toLowerCase();
        const to = String(decoded.args.to || "").toLowerCase();
        const value = BigInt(decoded.args.value || 0);

        if (
          from === normalizedAddress &&
          to === recipientAddress.toLowerCase() &&
          value >= requiredAmount
        ) {
          return {
            asset: "usdc" as const,
            amount: value.toString(),
          };
        }
      } catch {
        continue;
      }
    }

    throw new Error("USDC payment was not found in this transaction");
  }

  private async ensureTransactionHashUnusedForCheckIn(txHash: string) {
    const { data, error } = await postgresDb
      .from("check_ins")
      .select("id")
      .eq("payment_tx_hash", txHash)
      .limit(1);

    if (error) {
      throw new Error(`Check-in transaction reuse lookup failed: ${error.message}`);
    }

    if ((data ?? []).length > 0) {
      throw new Error("That check-in transaction has already been used");
    }
  }

  private async ensureTransactionMinedToday(txHash: string, now = new Date()) {
    const receipt = await getBaseTransactionReceipt(txHash as `0x${string}`);
    const block = await getBaseBlock(receipt.blockNumber);
    const minedAtMs = Number(block.timestamp) * 1000;

    if (!Number.isFinite(minedAtMs)) {
      throw new Error("Could not resolve the check-in transaction timestamp");
    }

    if (minedAtMs < getUtcStartOfDay(now).getTime()) {
      throw new Error("Check-in transaction must be mined today");
    }
  }

  private getConfiguredSpinContractAddress() {
    if (!SPIN_CONTRACT_ADDRESS) {
      throw new Error("Spin contract is not configured");
    }

    return SPIN_CONTRACT_ADDRESS;
  }

  private async adjustSpinTickets(userId: number, delta: number) {
    const { data, error } = await postgresDb.rpc("adjust_spin_tickets", {
      p_user_id: userId,
      p_delta: delta,
    });

    if (error) {
      if (error.message?.includes("insufficient_spin_tickets")) {
        throw new Error("You don't have any ticket to spin right now");
      }

      throw new Error(`Adjust spin tickets: ${error.message}`);
    }

    return Number(data || 0);
  }

  private verifySpinEvent(logs: readonly any[], normalizedAddress: string) {
    const spinContractAddress = this.getConfiguredSpinContractAddress();

    for (const log of logs) {
      if (String(log.address).toLowerCase() !== spinContractAddress) {
        continue;
      }

      try {
        const decoded = decodeEventLog({
          abi: SPIN_TRIGGER_ABI,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== "SpinTriggered") {
          continue;
        }

        const player = String(decoded.args.player || "").toLowerCase();
        if (player === normalizedAddress) {
          return;
        }
      } catch {
        continue;
      }
    }

    throw new Error("Spin transaction was not emitted by the configured contract");
  }

  private verifySmartWalletSpinCall(
    normalizedAddress: string,
    transaction: Awaited<ReturnType<typeof getBaseTransaction>>
  ) {
    const spinContractAddress = this.getConfiguredSpinContractAddress();

    if (
      !transaction.to ||
      transaction.to.toLowerCase() !== ENTRY_POINT_V06_ADDRESS ||
      transaction.value > 0n ||
      !transaction.input ||
      transaction.input === "0x"
    ) {
      return null;
    }

    try {
      const decodedEntryPointCall = decodeFunctionData({
        abi: ENTRY_POINT_HANDLE_OPS_ABI,
        data: transaction.input,
      });

      if (decodedEntryPointCall.functionName !== "handleOps") {
        return null;
      }

      const matchingOperation = decodedEntryPointCall.args[0].find(
        (operation) => operation.sender.toLowerCase() === normalizedAddress
      );

      if (!matchingOperation) {
        return null;
      }

      const decodedWalletCall = decodeFunctionData({
        abi: SMART_WALLET_EXECUTION_ABI,
        data: matchingOperation.callData,
      });

      const calls =
        decodedWalletCall.functionName === "execute"
          ? [
              {
                target: decodedWalletCall.args[0],
                value: decodedWalletCall.args[1],
                data: decodedWalletCall.args[2],
              },
            ]
          : decodedWalletCall.args[0];

      const matchingCall = calls.find(
        (call) =>
          call.target.toLowerCase() === spinContractAddress &&
          call.value === 0n &&
          String(call.data || "")
            .toLowerCase()
            .startsWith(SPIN_FUNCTION_SELECTOR)
      );

      return matchingCall || null;
    } catch {
      return null;
    }
  }

  private async verifySpinTransaction(normalizedAddress: string, txHash: string) {
    const spinContractAddress = this.getConfiguredSpinContractAddress();
    const [transaction, receipt] = await Promise.all([
      getBaseTransaction(txHash as `0x${string}`),
      getBaseTransactionReceipt(txHash as `0x${string}`),
    ]);

    if (receipt.status !== "success") {
      throw new Error("Spin transaction is not confirmed");
    }

    const smartWalletCall = this.verifySmartWalletSpinCall(normalizedAddress, transaction);
    if (smartWalletCall) {
      this.verifySpinEvent(receipt.logs, normalizedAddress);

      return {
        executionType: "smart_wallet" as const,
        contractAddress: spinContractAddress,
      };
    }

    if (transaction.from.toLowerCase() !== normalizedAddress) {
      throw new Error("Spin transaction sender does not match this wallet");
    }

    if (!transaction.to || transaction.to.toLowerCase() !== spinContractAddress) {
      throw new Error("Spin transaction was not sent to the configured contract");
    }

    if (transaction.value > 0n) {
      throw new Error("Spin transaction must not send ETH");
    }

    if (
      !transaction.input ||
      transaction.input === "0x" ||
      !transaction.input.toLowerCase().startsWith(SPIN_FUNCTION_SELECTOR)
    ) {
      throw new Error("Spin transaction does not call the expected contract method");
    }

    this.verifySpinEvent(receipt.logs, normalizedAddress);

    return {
      executionType: "eoa" as const,
      contractAddress: spinContractAddress,
    };
  }

  async dailyCheckIn(address: string, txHash: string, asset?: SaveAsset) {
    const normalizedAddress = address.toLowerCase();
    const user = await this.getOrCreate(normalizedAddress);
    const snapshot = buildStreakSnapshot(user);

    if (snapshot.checkedInToday) {
      throw new Error("Already checked in today");
    }

    await this.ensureTransactionHashUnusedForCheckIn(txHash);

    const payment = await this.verifyFeeTransaction(
      normalizedAddress,
      txHash,
      CFG.CHECK_IN_FEE_USD,
      asset,
      {
        allowBasePay: false,
        recipient: STREAK_SAVE_RECIPIENT,
        usdcAddress: STREAK_SAVE_USDC_ADDRESS,
      }
    );

    const now = new Date();
    await this.ensureTransactionMinedToday(txHash, now);

    const nextStreak = snapshot.status === "active" ? user.current_streak + 1 : 1;
    const unlockedBoostPercent = getBoostPercent(nextStreak);
    const multiplier = 1 + unlockedBoostPercent / 100;
    const pointsAwarded = Math.max(0, Math.floor(CFG.CHECK_IN * multiplier));
    const checkInDate = getUtcDayKey(now);
    const nowIso = now.toISOString();

    const { error: checkInInsertError } = await postgresDb.from("check_ins").insert({
      user_id: user.id,
      check_in_date: checkInDate,
      points_earned: pointsAwarded,
      streak_day: nextStreak,
      payment_tx_hash: txHash,
      payment_asset: payment.asset,
      payment_amount: payment.amount,
      payment_amount_usd: payment.amountUsd,
      price_snapshot_date: payment.priceDate,
    });

    if (checkInInsertError) {
      if (isPostgresUniqueViolation(checkInInsertError)) {
        throw new Error("Already checked in today");
      }

      throw new Error(`Record check-in: ${checkInInsertError.message}`);
    }

    const { error: pointEventInsertError } = await postgresDb.from("point_events").insert({
      user_id: user.id,
      action: "daily_check_in",
      points: CFG.CHECK_IN,
      multiplier,
      total_awarded: pointsAwarded,
      tx_hash: txHash,
      metadata: {
        basePoints: CFG.CHECK_IN,
        streakDay: nextStreak,
        boostPercent: unlockedBoostPercent,
        streakAtAward: nextStreak,
        boostApplied: unlockedBoostPercent > 0,
        unlockedBoostPercent,
        boostAppliesTo: "self_earned_only",
        paymentAsset: payment.asset,
        paymentAmount: payment.amount,
        paymentAmountUsd: payment.amountUsd,
        priceSnapshotDate: payment.priceDate,
        ethPriceUsd: payment.ethPriceUsd,
      },
      season: 1,
    });

    if (pointEventInsertError) {
      throw new Error(`Record check-in points: ${pointEventInsertError.message}`);
    }

    const nextUser = {
      ...user,
      current_streak: nextStreak,
      longest_streak: Math.max(nextStreak, user.longest_streak),
      last_check_in: nowIso,
      total_points: user.total_points + pointsAwarded,
    } as UserRecord;

    const { error: userUpdateError } = await postgresDb
      .from("users")
      .update({
        current_streak: nextUser.current_streak,
        longest_streak: nextUser.longest_streak,
        last_check_in: nextUser.last_check_in,
        total_points: nextUser.total_points,
        updated_at: nowIso,
      })
      .eq("id", user.id);

    if (userUpdateError) {
      throw new Error(`Update check-in balance: ${userUpdateError.message}`);
    }

    await this.awardReferralCommission(
      {
        ...nextUser,
        referred_by: user.referred_by,
      } as UserRecord,
      normalizedAddress,
      "daily_check_in",
      pointsAwarded,
      txHash
    );

    nextUser.spin_tickets = await this.adjustSpinTickets(
      user.id,
      CFG.SPIN_TICKETS_PER_CHECK_IN
    );

    this.invalidateUserReadCaches(normalizedAddress);

    return {
      points: pointsAwarded,
      pointsAwarded,
      paymentAsset: payment.asset,
      paymentAmountUsd: payment.amountUsd,
      unlockedBoostPercent,
      ...(await this.buildBalance(nextUser)),
    };
  }

  async resetBrokenStreak(address: string) {
    const user = await this.getOrCreate(address);
    const snapshot = buildStreakSnapshot(user);

    if (!snapshot.isBroken && !snapshot.missedStreak) {
      return {
        reset: false,
        ...(await this.buildBalance(user)),
      };
    }

    const nextUser = {
      ...user,
      current_streak: 0,
    } as UserRecord;

    await postgresDb
      .from("users")
      .update({
        current_streak: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    this.invalidateSummaryCache(address);

    return {
      reset: true,
      ...(await this.buildBalance(nextUser)),
    };
  }

  async recoverBrokenStreak(address: string, txHash: string, asset?: SaveAsset) {
    if (!STREAK_RECOVERY_ENABLED) {
      throw new Error("Streak recovery is currently disabled");
    }

    const normalizedAddress = address.toLowerCase();
    const user = await this.getOrCreate(normalizedAddress);
    const snapshot = buildStreakSnapshot(user);

    if (!snapshot.isBroken || snapshot.recoverableStreak <= 0) {
      throw new Error("No broken streak is available to restore");
    }

    const { data: existingRecovery } = await postgresDb
      .from("streak_recovery_events")
      .select("id")
      .eq("tx_hash", txHash)
      .maybeSingle();

    if (existingRecovery) {
      throw new Error("That recovery transaction has already been used");
    }

    const payment = await this.verifyFeeTransaction(
      normalizedAddress,
      txHash,
      CFG.STREAK_RESTORE_FEE_USD,
      asset
    );

    const restoredStreak = snapshot.recoverableStreak + 1;
    const restoredCheckInDate = getYesterdayUtcKey(new Date());
    const restoredLastCheckIn = getYesterdayUtcDate(new Date());
    restoredLastCheckIn.setUTCHours(23, 59, 59, 999);

    await postgresDb.from("streak_recovery_events").insert({
      user_id: user.id,
      tx_hash: txHash,
      asset_symbol: payment.asset.toUpperCase(),
      asset_address: payment.asset === "usdc" ? STREAK_SAVE_USDC_ADDRESS : null,
      amount: payment.amount,
      amount_usd: payment.amountUsd,
      previous_streak: snapshot.recoverableStreak,
      restored_streak: restoredStreak,
      status: "confirmed",
    });

    const nowIso = new Date().toISOString();
    const nextUser = {
      ...user,
      current_streak: restoredStreak,
      longest_streak: Math.max(restoredStreak, user.longest_streak),
      last_check_in: restoredLastCheckIn.toISOString(),
    } as UserRecord;

    if (restoredCheckInDate) {
      await postgresDb.from("check_ins").upsert(
        {
          user_id: user.id,
          check_in_date: restoredCheckInDate,
          points_earned: 0,
          streak_day: restoredStreak,
          payment_tx_hash: txHash,
          payment_asset: payment.asset,
          payment_amount: payment.amount,
          payment_amount_usd: payment.amountUsd,
          price_snapshot_date: payment.priceDate,
        },
        {
          onConflict: "user_id,check_in_date",
        }
      );
    }

    await postgresDb
      .from("users")
      .update({
        current_streak: nextUser.current_streak,
        longest_streak: nextUser.longest_streak,
        last_check_in: nextUser.last_check_in,
        updated_at: nowIso,
      })
      .eq("id", user.id);

    this.invalidateSummaryCache(normalizedAddress);

    return {
      restored: true,
      txHash,
      asset: payment.asset,
      paymentAmountUsd: payment.amountUsd,
      ...(await this.buildBalance(nextUser)),
    };
  }

  async spin(address: string, txHash: string) {
    const normalizedAddress = getAddress(address).toLowerCase();
    const user = await this.getOrCreate(normalizedAddress);

    if (Number(user.spin_tickets || 0) < CFG.SPIN_TICKET_COST) {
      throw new Error("You don't have any ticket to spin right now");
    }

    const { data: existingSpin } = await postgresDb
      .from("spin_history")
      .select("id")
      .eq("tx_hash", txHash)
      .maybeSingle();

    if (existingSpin) {
      throw new Error("That spin transaction has already been used");
    }

    const verification = await this.verifySpinTransaction(normalizedAddress, txHash);
    const remainingTickets = await this.adjustSpinTickets(user.id, -CFG.SPIN_TICKET_COST);
    const reward = pickSpinReward();

    const { error: historyError } = await postgresDb.from("spin_history").insert({
      user_id: user.id,
      tx_hash: txHash,
      reward_key: reward.key,
      reward_label: reward.label,
      reward_type: reward.type,
      reward_amount: reward.amount,
      reward_points: reward.pointsAwarded,
      reward_probability: reward.probability,
      ticket_cost: CFG.SPIN_TICKET_COST,
      execution_type: verification.executionType,
      status: "confirmed",
    });

    if (historyError) {
      await this.adjustSpinTickets(user.id, CFG.SPIN_TICKET_COST).catch(() => undefined);

      if (historyError.message?.toLowerCase().includes("duplicate")) {
        throw new Error("That spin transaction has already been used");
      }

      throw new Error(`Record spin history: ${historyError.message}`);
    }

    let nextUser = {
      ...user,
      spin_tickets: remainingTickets,
    } as UserRecord;

    if (reward.pointsAwarded > 0) {
      try {
        const rewardResult = await this.addPoints(
          normalizedAddress,
          reward.pointsAwarded,
          "spin_reward",
          txHash,
          {
            rewardKey: reward.key,
            rewardLabel: reward.label,
            rewardType: reward.type,
            rewardAmount: reward.amount,
            rewardProbability: reward.probability,
            executionType: verification.executionType,
            ticketCost: CFG.SPIN_TICKET_COST,
            contractAddress: verification.contractAddress,
          },
          {
            applyStreakBoost: false,
            applyReferralCommission: false,
          }
        );

        nextUser = {
          ...rewardResult.user,
          spin_tickets: remainingTickets,
        } as UserRecord;
      } catch (error) {
        await postgresDb
          .from("spin_history")
          .update({ status: "reward_failed" })
          .eq("tx_hash", txHash);
        throw error;
      }
    }

    this.invalidateUserReadCaches(normalizedAddress);

    return {
      txHash,
      ticketCost: CFG.SPIN_TICKET_COST,
      executionType: verification.executionType,
      reward: {
        key: reward.key,
        label: reward.label,
        type: reward.type,
        amount: reward.amount,
        pointsAwarded: reward.pointsAwarded,
        probability: reward.probability,
      },
      ...(await this.buildBalance(nextUser)),
    };
  }

  async getSpinHistory(address: string) {
    const user = await this.findExistingUser(address);
    if (!user) {
      return {
        history: [],
      };
    }

    const { data, error } = await postgresDb
      .from("spin_history")
      .select(
        "id, tx_hash, reward_key, reward_label, reward_type, reward_amount, reward_points, reward_probability, ticket_cost, execution_type, status, created_at"
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) {
      throw new Error(`Load spin history: ${error.message}`);
    }

    return {
      history: ((data ?? []) as SpinHistoryRow[]).map(normalizeSpinRewardRow),
    };
  }

  async recordSweep(
    address: string,
    txHash: string,
    tokenCount: number,
    volumeUsd: number
  ): Promise<number> {
    const basePoints = tokenCount * CFG.SWEEP_PER_TOKEN * CFG.SWEEP_MULTIPLIER;
    const today = await this.todayBasePoints(address, "dust_sweep");
    const capped = Math.max(0, Math.min(basePoints, CFG.CAP_SWEEP - today));
    if (capped <= 0) {
      return 0;
    }

    const award = await this.addPoints(address, capped, "dust_sweep", txHash, {
      tokenCount,
      volumeUsd,
    });

    return award.totalAwarded;
  }

  async recordBridge(
    address: string,
    txHash: string,
    tokenCount: number,
    sourceChain: number,
    volumeUsd: number
  ): Promise<number> {
    const basePoints = tokenCount * CFG.BRIDGE_PER_TOKEN * CFG.BRIDGE_MULTIPLIER;
    const today = await this.todayBasePoints(address, "dust_bridge");
    const capped = Math.max(0, Math.min(basePoints, CFG.CAP_BRIDGE - today));
    if (capped <= 0) {
      return 0;
    }

    const award = await this.addPoints(address, capped, "dust_bridge", txHash, {
      tokenCount,
      sourceChain,
      volumeUsd,
    });

    return award.totalAwarded;
  }

  async recordBurn(address: string, txHash: string, tokenCount: number): Promise<number> {
    const basePoints = tokenCount * CFG.BURN_PER_TOKEN * CFG.BURN_MULTIPLIER;
    const today = await this.todayBasePoints(address, "token_burn");
    const capped = Math.max(0, Math.min(basePoints, CFG.CAP_BURN - today));
    if (capped <= 0) {
      return 0;
    }

    const award = await this.addPoints(address, capped, "token_burn", txHash, {
      tokenCount,
    });
    return award.totalAwarded;
  }

  async recordSwap(
    address: string,
    input: {
      txHash?: string | null;
      orderId?: string | null;
      chainId?: number | null;
      inputToken?: string | null;
      outputToken?: string | null;
      amountIn?: string | null;
      amountOut?: string | null;
      volumeUsd?: number | null;
      awardPoints?: boolean;
    }
  ): Promise<number> {
    const user = await this.getOrCreate(address);
    const historyKey = input.txHash || input.orderId;
    const shouldAwardPoints = input.awardPoints ?? true;
    const resolvedChainId = input.chainId || base.id;

    if (!historyKey) {
      throw new Error("Swap transaction id required");
    }

    const { data: existingHistory, error: historyLookupError } = await postgresDb
      .from("sweep_history")
      .select("points_earned")
      .eq("tx_hash", historyKey)
      .eq("chain_id", resolvedChainId)
      .eq("type", "swap")
      .maybeSingle();

    if (historyLookupError) {
      throw new Error(`Check swap history: ${historyLookupError.message}`);
    }

    if (existingHistory) {
      return Number((existingHistory as { points_earned?: number | null }).points_earned || 0);
    }

    const today = shouldAwardPoints ? await this.todayBasePoints(address, "swap") : 0;
    const capped = shouldAwardPoints
      ? Math.max(0, Math.min(CFG.SWAP, CFG.CAP_SWAP - today))
      : 0;
    const award =
      shouldAwardPoints && capped > 0
        ? await this.addPoints(address, capped, "swap", historyKey, {
            orderId: input.orderId || null,
            inputToken: input.inputToken || null,
            outputToken: input.outputToken || null,
            amountIn: input.amountIn || null,
            amountOut: input.amountOut || null,
            volumeUsd: parseUsdAmount(input.volumeUsd ?? null),
          })
        : { totalAwarded: 0 };

    const { error } = await postgresDb.from("sweep_history").insert({
      user_id: user.id,
      tx_hash: historyKey,
      chain_id: resolvedChainId,
      input_tokens: [
        {
          token: input.inputToken || "0x0000000000000000000000000000000000000000",
          amount: input.amountIn || "0",
        },
      ],
      output_token: input.outputToken || "0x0000000000000000000000000000000000000000",
      output_amount: input.amountOut || "0",
      output_value_usd: parseUsdAmount(input.volumeUsd ?? null),
      fee_amount: null,
      token_count: 1,
      type: "swap",
      status: input.txHash ? "confirmed" : "pending",
      points_earned: award.totalAwarded,
    });

    if (error) {
      throw new Error(`Record swap history: ${error.message}`);
    }

    this.invalidateUserReadCaches(address);

    return award.totalAwarded;
  }

  async getBalance(address: string) {
    const user = await this.findExistingUser(address);
    if (!user) {
      return this.buildDefaultBalance(address);
    }

    return this.buildBalance(user, {
      readOnlyPrice: true,
    });
  }

  private normalizeFootprintFollowTask(taskKey?: string | null): FootprintFollowTaskKey {
    const key = String(taskKey || "dustswap").trim().toLowerCase();
    if (key in FOOTPRINT_FOLLOW_TARGETS) {
      return key as FootprintFollowTaskKey;
    }

    throw new Error("Unknown Footprint Drop X follow task");
  }

  private async getFootprintFollowVerification(
    userId: number,
    taskKey: FootprintFollowTaskKey
  ) {
    const { data, error } = await postgresDb
      .from("footprint_social_verifications")
      .select("*")
      .eq("user_id", userId)
      .eq("task_key", taskKey)
      .eq("platform", "x")
      .maybeSingle();

    if (error) {
      const message = String(error.message || "").toLowerCase();
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        message.includes("footprint_social_verifications")
      ) {
        return null;
      }

      throw new Error(`Load Footprint X verification: ${error.message}`);
    }

    return (data as
      | {
          verified_by_api: boolean | null;
          verified_at: string | null;
          source_x_user_id: string | null;
          target_x_user_id: string | null;
        }
      | null) ?? null;
  }

  private async isFootprintFollowVerified(userId: number) {
    const verification = await this.getFootprintFollowVerification(userId, "dustswap");
    return Boolean(verification?.verified_by_api && verification.verified_at);
  }

  private async assertFootprintFollowVerified(userId: number) {
    const verified = await this.isFootprintFollowVerified(userId);
    if (!verified) {
      throw new Error("Verify the DustSwap X follow before claiming your Footprint Drop.");
    }
  }

  async verifyFootprintFollow(address: string, taskKey?: string | null) {
    const normalizedAddress = getAddress(address).toLowerCase();
    const normalizedTaskKey = this.normalizeFootprintFollowTask(taskKey);
    const target = FOOTPRINT_FOLLOW_TARGETS[normalizedTaskKey];
    const user = await this.getOrCreate(normalizedAddress);
    const connectedAccount = await xVerificationService.requireConnectedAccount(user.id);
    const checkedAt = new Date().toISOString();
    const followCheck = await xVerificationService.checkFollowRelationship(
      {
        userId: connectedAccount.xUserId,
        username: connectedAccount.username,
      },
      target
    );

    const row = {
      user_id: user.id,
      wallet_address: normalizedAddress,
      task_key: normalizedTaskKey,
      platform: "x",
      source_x_user_id: connectedAccount.xUserId,
      target_x_user_id: followCheck.targetUser.id,
      target_username: followCheck.targetUser.userName,
      verified_by_api: followCheck.verified,
      verified_at: followCheck.verified ? checkedAt : null,
      metadata: {
        provider: "getx",
        checkedAt,
        sourceUsername: followCheck.sourceUser.userName,
        targetUsername: followCheck.targetUser.userName,
        rawRelationship: followCheck.raw,
      },
      updated_at: checkedAt,
    };

    const { error } = await postgresDb
      .from("footprint_social_verifications")
      .upsert(row, {
        onConflict: "user_id,task_key,platform",
      });

    if (error) {
      throw new Error(`Save Footprint X verification: ${error.message}`);
    }

    this.invalidateFootprintStatusCache(normalizedAddress);

    return {
      success: true,
      verified: followCheck.verified,
      taskKey: normalizedTaskKey,
      targetUsername: followCheck.targetUser.userName,
      targetXUserId: followCheck.targetUser.id,
      sourceXUserId: connectedAccount.xUserId,
      verifiedAt: followCheck.verified ? checkedAt : null,
      message: followCheck.verified
        ? "X follow verified."
        : `Follow @${followCheck.targetUser.userName}, then verify again.`,
    } as const;
  }

  async getFootprintAirdropStatus(address: string) {
    const normalizedAddress = getAddress(address).toLowerCase();
    const cacheKey = this.getFootprintStatusCacheKey(normalizedAddress);

    return runtimeCache.getOrSet(cacheKey, FOOTPRINT_STATUS_CACHE_TTL_MS, async () => {
      const existingUser = await this.findExistingUser(normalizedAddress);
      const footprintFollowVerified = existingUser
        ? await this.isFootprintFollowVerified(existingUser.id)
        : false;

      if (existingUser) {
        const existingClaim = await this.getExistingFootprintClaimByUserId(existingUser.id);
        if (existingClaim) {
          return {
            ...this.normalizeFootprintClaim(normalizedAddress, existingClaim),
            claimConfig: null,
            footprintFollowVerified: true,
            referralCommissionPct: CFG.REFERRAL_COMMISSION_PCT,
          };
        }
      }

      const lookup = await footprintAirdropService.lookupReward(normalizedAddress);
      const priceSnapshot = lookup.eligible
        ? await this.getDailyEthPriceSnapshot()
        : null;
      const claimConfig = priceSnapshot
        ? buildFeeConfig(
            priceSnapshot,
            CFG.FOOTPRINT_CLAIM_FEE_USD,
            FOOTPRINT_CLAIM_RECIPIENT,
            FOOTPRINT_CLAIM_USDC_ADDRESS
          )
        : null;

      return {
        ...lookup,
        claimed: false,
        claimable: lookup.eligible,
        claimedAt: null,
        claimConfig,
        footprintFollowVerified,
        referralCommissionPct: CFG.REFERRAL_COMMISSION_PCT,
      };
    });
  }

  async claimFootprintAirdrop(address: string, txHash?: string, asset?: SaveAsset) {
    const normalizedAddress = getAddress(address).toLowerCase();
    const user = await this.getOrCreate(normalizedAddress);
    const existingClaim = await this.getExistingFootprintClaimByUserId(user.id);

    if (existingClaim) {
      const normalizedClaim = this.normalizeFootprintClaim(
        normalizedAddress,
        existingClaim
      );

      return {
        ...normalizedClaim,
        alreadyClaimed: true,
        claimConfig: null,
        totalPoints: user.total_points,
        footprintFollowVerified: true,
        referralCommissionPct: CFG.REFERRAL_COMMISSION_PCT,
      };
    }

    const lookup = await footprintAirdropService.lookupReward(normalizedAddress);

    if (!lookup.eligible || lookup.rewardPoints <= 0) {
      throw new Error(
        lookup.reason || "This wallet is not eligible for the Footprint Drop."
      );
    }

    await this.assertFootprintFollowVerified(user.id);

    if (!txHash) {
      throw new Error("txHash required for onchain Footprint Drop claim verification");
    }

    const payment = await this.verifyFeeTransaction(
      normalizedAddress,
      txHash,
      CFG.FOOTPRINT_CLAIM_FEE_USD,
      asset,
      {
        allowBasePay: false,
        recipient: FOOTPRINT_CLAIM_RECIPIENT,
        usdcAddress: FOOTPRINT_CLAIM_USDC_ADDRESS,
      }
    );

    const award = await this.addPoints(
      normalizedAddress,
      lookup.rewardPoints,
      "footprint_airdrop_claim",
      txHash,
      {
        dropName: "Footprint Drop",
        sourceKind: lookup.source,
        tierLabel: lookup.tierLabel,
        rangeMin: lookup.rangeMin,
        rangeMax: lookup.rangeMax,
        allowlistTotalUsdc: lookup.allowlistTotalUsdc,
        transactionsCount: lookup.transactionsCount,
        tokenTransfersCount: lookup.tokenTransfersCount,
        totalActivity: lookup.totalActivity,
        paymentAsset: payment.asset,
        paymentAmount: payment.amount,
        paymentAmountUsd: payment.amountUsd,
        priceSnapshotDate: payment.priceDate,
        ethPriceUsd: payment.ethPriceUsd,
      },
      { applyStreakBoost: false }
    );

    const storedClaim = await this.getExistingFootprintClaimByUserId(user.id);
    const normalizedClaim = storedClaim
      ? this.normalizeFootprintClaim(normalizedAddress, storedClaim)
      : {
          ...lookup,
          claimed: true,
          claimable: false,
          claimedAt: new Date().toISOString(),
        };

    this.invalidateFootprintStatusCache(normalizedAddress);

    return {
      ...normalizedClaim,
      alreadyClaimed: false,
      claimConfig: null,
      totalPoints: award.user.total_points,
      footprintFollowVerified: true,
      referralCommissionPct: CFG.REFERRAL_COMMISSION_PCT,
    };
  }

  async getPointsSummary(address: string) {
    const normalizedAddress = this.normalizeStoredAddress(address);
    const cacheKey = this.getPointsSummaryCacheKey(normalizedAddress);

    return runtimeCache.getOrSet(cacheKey, POINTS_SUMMARY_CACHE_TTL_MS, async () => {
      const user = await this.findExistingUser(normalizedAddress);
      if (!user) {
        return this.buildDefaultPointsSummary(normalizedAddress);
      }

      const [balance, stats, referral] = await Promise.all([
        this.buildBalance(user, {
          readOnlyPrice: true,
        }),
        this.getSweepStatsByUserId(user.id),
        this.getReferralStatsByUserId(user.id),
      ]);

      return {
        balance: {
          success: true,
          ...balance,
        },
        stats: {
          success: true,
          totalPoints: user.total_points,
          ...stats,
        },
        referral: {
          success: true,
          code: user.referral_code,
          hasReferrer: user.referred_by !== null,
          ...referral,
        },
      };
    });
  }

  async getUserStats(address: string) {
    const user = await this.findExistingUser(address);
    if (!user) {
      return this.buildDefaultUserStats();
    }

    const stats = await this.getSweepStatsByUserId(user.id);

    return {
      totalPoints: user.total_points,
      ...stats,
    };
  }

  async getReferralStats(address: string) {
    const user = await this.findExistingUser(address);
    if (!user) {
      return this.buildDefaultReferralStats();
    }

    const referral = await this.getReferralStatsByUserId(user.id);

    return {
      code: user.referral_code,
      ...referral,
    };
  }

  async getPointHistory(address: string, limit = 50) {
    const user = await this.findExistingUser(address);
    if (!user) {
      return [];
    }

    const { data, error } = await postgresDb
      .from("point_events")
      .select("id, action, points, metadata, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Load point history: ${error.message}`);
    }

    const formatAction = (action: string) => {
      if (action === "spin") return "Spin";
      if (action === "referral_new_user") return "Referral join";
      if (action === "referral_commission") return "Referral";
      if (action.startsWith("quest_completion")) return "Quest";
      if (action === "check_in") return "Daily Check-in";
      if (action === "footprint_airdrop_claim") return "Footprint Airdrop";
      if (action === "sweep") return "Dust Sweep";
      if (action === "swap") return "Swap";
      if (action === "bridge") return "Bridge";
      if (action === "burn") return "Burn";
      if (action === "admin_manual_pp_grant") return "Admin Bonus";
      
      return action
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    };

    return (data || []).map((row: any) => {
      let label = formatAction(row.action);
      if (row.action === "quest_completion" && row.metadata?.questTitle) {
        label = String(row.metadata.questTitle);
      } else if (row.action === "admin_manual_pp_grant" && row.metadata?.note) {
        label = `Bonus: ${row.metadata.note}`;
      }

      return {
        id: row.id,
        action: row.action,
        label,
        points: Number(row.points || 0),
        createdAt: row.created_at,
      };
    });
  }

  async getLeaderboard(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const pageEntries = await this.getParticlePointLeaderboardPage(offset, limit);

    return pageEntries.map((entry) => {
      const snapshot = buildStreakSnapshot({
        current_streak: entry.currentStreak,
        last_check_in: entry.lastCheckIn,
      } as Pick<UserRecord, "current_streak" | "last_check_in">);

      return {
        rank: entry.rank,
        address: entry.address,
        points: entry.totalPoints,
        streak: snapshot.activeStreak,
        boostPercent: snapshot.boostPercent,
      };
    });
  }

  async getLeaderboardHub(
    type: LeaderboardKind,
    options?: {
      page?: number;
      pageSize?: number;
      viewerAddress?: string;
    }
  ): Promise<LeaderboardHubResponse> {
    const requestedPageSize = options?.pageSize ?? 10;
    const viewerAddress = options?.viewerAddress;
    const safeLimit = Math.max(1, Math.min(50, requestedPageSize));
    const currentPageInput = Math.max(1, options?.page ?? 1);
    const cacheKey = this.getLeaderboardCacheKey(
      type,
      currentPageInput,
      safeLimit,
      viewerAddress
    );

    return runtimeCache.getOrSet(cacheKey, LEADERBOARD_CACHE_TTL_MS, async () => {
      const { totalParticlePoints, totalUserCount } = await this.getPointsOverview();
      const getPagination = (entryCount: number) => {
        const totalEntries = Math.max(0, entryCount);
        const totalPages = Math.max(1, Math.ceil(totalEntries / safeLimit));
        const currentPage = Math.min(currentPageInput, totalPages);
        const offset = (currentPage - 1) * safeLimit;

        return { currentPage, offset, totalEntries, totalPages };
      };

      if (type === "particle_points") {
        const { currentPage, offset, totalEntries, totalPages } =
          getPagination(totalUserCount);
        const pageEntries = await this.getParticlePointLeaderboardPage(offset, safeLimit);
        const profiles = await this.fetchCachedProfiles(
          pageEntries.map((entry) => entry.userId)
        );
        const viewer = await this.buildParticlePointsViewerEntry(viewerAddress);

        return {
          type,
          limit: safeLimit,
          page: currentPage,
          pageSize: safeLimit,
          totalEntries,
          totalPages,
          totalUserCount,
          totalParticlePoints,
          viewer,
          entries: pageEntries.map((entry) => ({
            rank: entry.rank,
            userId: entry.userId,
            address: entry.address,
            totalPoints: entry.totalPoints,
            referralPoints: 0,
            referredUsers: 0,
            swapVolume: 0,
            profile: profiles.get(entry.userId) ?? null,
          })),
        } satisfies LeaderboardHubResponse;
      }

      if (type === "referral") {
        const snapshotMeta = await this.ensureReferralLeaderboardSnapshot();
        if (!snapshotMeta) {
          const referralTotalEntries = await this.getLiveReferralLeaderboardCount();
          const { currentPage, offset, totalEntries, totalPages } =
            getPagination(referralTotalEntries);
          const pageEntries = await this.getLiveReferralLeaderboardPage(offset, safeLimit);
          const viewerUser = viewerAddress ? await this.findExistingUser(viewerAddress) : null;
          const [profiles, viewerRow, viewerProfiles] = await Promise.all([
            this.fetchCachedProfiles(pageEntries.map((entry) => entry.userId)),
            viewerUser
              ? this.getLiveReferralLeaderboardViewer(viewerUser.id)
              : Promise.resolve(null),
            viewerUser ? this.fetchCachedProfiles([viewerUser.id]) : Promise.resolve(new Map()),
          ]);

          return {
            type,
            limit: safeLimit,
            page: currentPage,
            pageSize: safeLimit,
            totalEntries,
            totalPages,
            totalUserCount,
            totalParticlePoints,
            viewer: viewerRow
              ? {
                  ...viewerRow,
                  profile: viewerProfiles.get(viewerRow.userId) ?? null,
                }
              : null,
            entries: pageEntries.map((entry) => ({
              ...entry,
              profile: profiles.get(entry.userId) ?? null,
            })),
          } satisfies LeaderboardHubResponse;
        }

        const referralTotalEntries = Number(snapshotMeta.total_entries || 0);
        const { currentPage, offset, totalEntries, totalPages } =
          getPagination(referralTotalEntries);
        const pageEntries =
          (await this.getReferralLeaderboardSnapshotPage(offset, safeLimit)) ??
          (await this.getLiveReferralLeaderboardPage(offset, safeLimit));
        const viewerUser = viewerAddress ? await this.findExistingUser(viewerAddress) : null;
        const [profiles, viewerRow, viewerProfiles] = await Promise.all([
          this.fetchCachedProfiles(pageEntries.map((entry) => entry.userId)),
          viewerUser
            ? this.getReferralLeaderboardSnapshotViewer(viewerUser.id).then((entry) => {
                return entry ?? this.getLiveReferralLeaderboardViewer(viewerUser.id);
              })
            : Promise.resolve(null),
          viewerUser ? this.fetchCachedProfiles([viewerUser.id]) : Promise.resolve(new Map()),
        ]);

        return {
          type,
          limit: safeLimit,
          page: currentPage,
          pageSize: safeLimit,
          totalEntries,
          totalPages,
          totalUserCount,
          totalParticlePoints,
          viewer: viewerRow
            ? {
                ...viewerRow,
                profile: viewerProfiles.get(viewerRow.userId) ?? null,
              }
            : null,
          entries: pageEntries.map((entry) => ({
            ...entry,
            profile: profiles.get(entry.userId) ?? null,
          })),
        } satisfies LeaderboardHubResponse;
      }

      const { currentPage, offset, totalEntries, totalPages } =
        getPagination(totalUserCount);
      const pageEntries = await this.getVolumeLeaderboardPage(offset, safeLimit);
      const viewerUser = viewerAddress ? await this.findExistingUser(viewerAddress) : null;
      const [profiles, viewerRow, viewerProfiles] = await Promise.all([
        this.fetchCachedProfiles(pageEntries.map((entry) => entry.userId)),
        viewerUser ? this.getVolumeLeaderboardViewer(viewerUser.id) : Promise.resolve(null),
        viewerUser ? this.fetchCachedProfiles([viewerUser.id]) : Promise.resolve(new Map()),
      ]);

      return {
        type,
        limit: safeLimit,
        page: currentPage,
        pageSize: safeLimit,
        totalEntries,
        totalPages,
        totalUserCount,
        totalParticlePoints,
        viewer: viewerRow
          ? {
              ...viewerRow,
              profile: viewerProfiles.get(viewerRow.userId) ?? null,
            }
          : null,
        entries: pageEntries.map((entry) => ({
          ...entry,
          profile: profiles.get(entry.userId) ?? null,
        })),
      } satisfies LeaderboardHubResponse;
    });
  }

  async previewReferral(
    userAddress: string,
    code: string
  ): Promise<{ valid: boolean; normalizedCode: string; message: string }> {
    const normalizedCode = code.trim().toUpperCase();
    const normalizedUserAddress = this.normalizeStoredAddress(userAddress);

    if (!normalizedCode) {
      return { valid: false, normalizedCode, message: "Enter a referral code." };
    }

    const user = await this.findExistingUser(normalizedUserAddress);

    if (user?.referred_by) {
      return { valid: false, normalizedCode, message: "You have already applied a referral code." };
    }

    const { data: referrer } = await postgresDb
      .from("users")
      .select("id, address")
      .eq("referral_code", normalizedCode)
      .maybeSingle();

    if (!referrer) {
      return { valid: false, normalizedCode, message: "Invalid referral code." };
    }

    if (
      String((referrer as { address: string }).address).toLowerCase() ===
      normalizedUserAddress
    ) {
      return { valid: false, normalizedCode, message: "You cannot use your own referral code." };
    }

    return { valid: true, normalizedCode, message: "Valid referral code! Apply to get 500 PP." };
  }

  async applyReferral(
    userAddress: string,
    code: string
  ): Promise<ReferralApplyResult> {
    const normalizedAddress = this.getReferralApplyKey(userAddress);
    const normalizedCode = code.trim().toUpperCase();

    if (!normalizedAddress || !normalizedCode) {
      throw new Error("address and referralCode required");
    }

    const recent = this.getRecentReferralApply(normalizedAddress, normalizedCode);
    if (recent) {
      return {
        ...recent.result,
        idempotent: true,
      };
    }

    const inflight = this.referralApplyInflight.get(normalizedAddress);
    if (inflight) {
      if (inflight.code === normalizedCode) {
        return inflight.promise;
      }

      throw new Error("Referral application already in progress");
    }

    const request = this.applyReferralOnce(
      normalizedAddress,
      normalizedCode
    ).finally(() => {
      const current = this.referralApplyInflight.get(normalizedAddress);
      if (current?.promise === request) {
        this.referralApplyInflight.delete(normalizedAddress);
      }
    });

    this.referralApplyInflight.set(normalizedAddress, {
      code: normalizedCode,
      promise: request,
    });

    return request;
  }

  private async applyReferralOnce(
    userAddress: string,
    normalizedCode: string
  ): Promise<ReferralApplyResult> {
    const recent = this.getRecentReferralApply(userAddress, normalizedCode);
    if (recent) {
      return {
        ...recent.result,
        idempotent: true,
      };
    }

    const { data: referrer, error: referrerError } = await postgresDb
      .from("users")
      .select("id, address")
      .eq("referral_code", normalizedCode)
      .maybeSingle();

    if (referrerError) {
      throw new Error(`Load referrer: ${referrerError.message}`);
    }

    if (!referrer) {
      return this.rememberTerminalReferralApply(
        userAddress,
        normalizedCode,
        "Invalid referral code"
      );
    }
    if (String((referrer as UserRecord).address).toLowerCase() === userAddress.toLowerCase()) {
      return this.rememberTerminalReferralApply(
        userAddress,
        normalizedCode,
        "Cannot self-refer"
      );
    }

    const user = await this.findExistingUser(userAddress);
    if (!user) {
      return this.getDeferredReferralApplyResult();
    }

    if (user.referred_by) {
      return {
        ...this.rememberTerminalReferralApply(
          userAddress,
          normalizedCode,
          "Already referred"
        ),
        idempotent: true,
      };
    }

    const existingReferral = await this.getReferralLedgerByRefereeId(user.id);
    if (existingReferral) {
      const result = this.rememberReferralApply(userAddress, normalizedCode, {
        ...this.getAppliedReferralResult(),
        idempotent: true,
      });

      return result;
    }

    if (!(await this.hasReferralActivation(user))) {
      return this.getDeferredReferralApplyResult();
    }

    const { data: linkedUser, error: linkError } = await postgresDb
      .from("users")
      .update({
        referred_by: Number((referrer as { id: number }).id),
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id)
      .is("referred_by", null)
      .select("id, address")
      .maybeSingle();

    if (linkError) {
      throw new Error(`Link referral: ${linkError.message}`);
    }

    if (!linkedUser) {
      const latestUser = await this.findExistingUser(userAddress);
      if (!latestUser) {
        return this.getDeferredReferralApplyResult();
      }

      if (latestUser.referred_by === Number((referrer as { id: number }).id)) {
        const result = this.rememberReferralApply(
          userAddress,
          normalizedCode,
          this.getAppliedReferralResult()
        );
        return {
          ...result,
          idempotent: true,
        };
      }

      if (!(await this.hasReferralActivation(latestUser))) {
        return this.getDeferredReferralApplyResult();
      }

      if (latestUser.referred_by) {
        return {
          ...this.rememberTerminalReferralApply(
            userAddress,
            normalizedCode,
            "Already referred"
          ),
          idempotent: true,
        };
      }

      const latestReferral = await this.getReferralLedgerByRefereeId(latestUser.id);
      if (
        latestReferral &&
        Number(latestReferral.referrer_id) === Number((referrer as { id: number }).id)
      ) {
        const result = this.rememberReferralApply(
          userAddress,
          normalizedCode,
          this.getAppliedReferralResult()
        );
        return {
          ...result,
          idempotent: true,
        };
      }

      if (latestReferral) {
        return {
          ...this.rememberTerminalReferralApply(
            userAddress,
            normalizedCode,
            "Already referred"
          ),
          idempotent: true,
        };
      }

      return {
        ...this.rememberTerminalReferralApply(
          userAddress,
          normalizedCode,
          "Already referred"
        ),
        idempotent: true,
      };
    }

    const result = await this.finalizeReferralLink(
      linkedUser as Pick<UserRecord, "id" | "address">,
      referrer as Pick<UserRecord, "id" | "address">,
      normalizedCode
    );

    this.rememberReferralApply(userAddress, normalizedCode, result);

    return result;
  }
}

export const pointsEngine = new PointsEngine();
