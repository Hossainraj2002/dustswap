import {
  createPublicClient,
  decodeFunctionData,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
} from "viem";
import { base } from "viem/chains";
import { getPaymentStatus } from "@base-org/account/payment";
import { supabase } from "./supabase";

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

  CHECK_IN_FEE_USD: 0.01,
  STREAK_RESTORE_FEE_USD: 1,
} as const;

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
const ENTRY_POINT_V06_ADDRESS = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
const DEFAULT_ETH_PRICE_USD = Number(process.env.DEFAULT_ETH_PRICE_USD || "3500");
const PRICE_SCALE = 100_000_000;
const WEI_PER_ETH = 10n ** 18n;
const ENTRY_POINT_HANDLE_OPS_ABI = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)",
]);
const SMART_WALLET_EXECUTION_ABI = parseAbi([
  "function execute(address target,uint256 value,bytes data)",
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
]);

const baseClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
});

type UserRecord = {
  id: number;
  address: string;
  referral_code: string;
  referred_by: number | null;
  total_points: number;
  current_streak: number;
  longest_streak: number;
  last_check_in: string | null;
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

type CachedFarcasterProfile = {
  fid: string | null;
  username: string | null;
  displayName: string | null;
  pfpUrl: string | null;
  updatedAt: string | null;
};

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
  totalUserCount: number;
  viewer: LeaderboardEntry | null;
  entries: LeaderboardEntry[];
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

type StreakSnapshot = {
  status: StreakStatus;
  checkedInToday: boolean;
  isBroken: boolean;
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

function getBoostPercent(streak: number) {
  if (streak <= 0) {
    return 0;
  }

  return Math.min(
    CFG.MAX_STREAK_BOOST_PERCENT,
    streak * CFG.STREAK_BOOST_STEP_PERCENT
  );
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
  const storedStreak = Number(user.current_streak || 0);
  const checkedInToday = Boolean(lastCheckInKey && lastCheckInKey === todayKey);
  const checkedInYesterday = Boolean(lastCheckInKey && lastCheckInKey === yesterdayKey);
  const isBroken = storedStreak > 0 && !checkedInToday && !checkedInYesterday;
  const activeStreak = isBroken ? 0 : storedStreak;
  const recoverableStreak = isBroken ? storedStreak : 0;
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
    "daily_check_in",
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

function calculateEthWeiFromUsd(usdAmount: number, ethPriceUsd: number) {
  const usdScaled = BigInt(Math.round(usdAmount * PRICE_SCALE));
  const ethPriceScaled = BigInt(Math.round(ethPriceUsd * PRICE_SCALE));

  if (usdScaled <= 0n || ethPriceScaled <= 0n) {
    throw new Error("Invalid ETH price snapshot");
  }

  return (usdScaled * WEI_PER_ETH + ethPriceScaled - 1n) / ethPriceScaled;
}

function buildFeeConfig(snapshot: DailyAssetPriceRecord, usdTarget: number): FeeConfig {
  const usdcUnits = getUsdcUnitsForUsd(usdTarget);
  const ethWei = calculateEthWeiFromUsd(usdTarget, snapshot.price_usd);

  return {
    chainId: base.id,
    recipient: STREAK_SAVE_RECIPIENT,
    usdcAddress: STREAK_SAVE_USDC_ADDRESS,
    usdTarget,
    usdcAmount: usdTarget.toFixed(2),
    usdcAmountUnits: usdcUnits.toString(),
    ethAmountWei: ethWei.toString(),
    ethAmountDisplay: formatUnits(ethWei, 18),
    ethPriceUsd: snapshot.price_usd,
    priceDate: snapshot.price_date,
  };
}

export class PointsEngine {
  async getOrCreate(address: string): Promise<UserRecord> {
    const norm = address.toLowerCase();
    const { data } = await supabase.from("users").select("*").eq("address", norm).single();
    if (data) {
      const user = data as UserRecord;
      if (!user.referral_code) {
        const code = genCode();
        await supabase.from("users").update({ referral_code: code }).eq("id", user.id);
        user.referral_code = code;
      }
      return user;
    }

    const { data: nu, error } = await supabase
      .from("users")
      .insert({
        address: norm,
        referral_code: genCode(),
        total_points: 0,
        current_streak: 0,
        longest_streak: 0,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Create user: ${error.message}`);
    }

    return nu as UserRecord;
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
    const { data, error } = await supabase
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

    const { data, error } = await supabase
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
      const { data: inserted, error: upsertError } = await supabase
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
      const existing = normalizeDailyPriceRow(data);

      if (existing.source.startsWith("fallback_")) {
        try {
          const liveQuote = await this.fetchCurrentEthPriceUsd();
          return upsertRow(liveQuote.priceUsd, liveQuote.source, {
            ...(liveQuote.metadata ?? {}),
            replacedFallbackSource: existing.source,
            replacedFallbackDate: existing.price_date,
            syncedAt: new Date().toISOString(),
          });
        } catch {
          return existing;
        }
      }

      return existing;
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

  private async buildBalance(user: UserRecord) {
    const snapshot = buildStreakSnapshot(user);
    const priceSnapshot = await this.getDailyEthPriceSnapshot();
    const checkInConfig = buildFeeConfig(priceSnapshot, CFG.CHECK_IN_FEE_USD);
    const saveConfig = buildFeeConfig(priceSnapshot, CFG.STREAK_RESTORE_FEE_USD);

    const { count } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .gt("total_points", user.total_points);

    return {
      totalPoints: user.total_points,
      rank: (count ?? 0) + 1,
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
      checkInRewardPoints: CFG.CHECK_IN,
      nextBoostPercent: getBoostPercent(snapshot.activeStreak + 1),
      boostCapPercent: CFG.MAX_STREAK_BOOST_PERCENT,
      boostStepPercent: CFG.STREAK_BOOST_STEP_PERCENT,
      boostAppliesTo:
        "Self-earned points get the boost. Referral points stay unchanged.",
      streakLength: CFG.STREAK_LENGTH,
      checkInConfig,
      saveConfig,
    };
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
    record: Pick<
      SocialAccountRecord,
      "platform_user_id" | "username" | "display_name" | "profile_image_url" | "updated_at"
    > | null
  ): CachedFarcasterProfile | null {
    if (!record) {
      return null;
    }

    return {
      fid: record.platform_user_id || null,
      username: record.username || null,
      displayName: record.display_name || null,
      pfpUrl: record.profile_image_url || null,
      updatedAt: record.updated_at || null,
    };
  }

  private async fetchCachedProfiles(userIds: number[]) {
    const uniqueUserIds = [...new Set(userIds.filter((value) => Number.isFinite(value)))];
    const profiles = new Map<number, CachedFarcasterProfile>();

    if (!uniqueUserIds.length) {
      return profiles;
    }

    const { data, error } = await supabase
      .from("social_accounts")
      .select(
        "user_id, platform_user_id, username, display_name, profile_image_url, updated_at"
      )
      .eq("platform", "farcaster")
      .in("user_id", uniqueUserIds);

    if (error) {
      throw new Error(`Fetch social profiles: ${error.message}`);
    }

    for (const row of (data ?? []) as Array<
      Pick<
        SocialAccountRecord,
        "user_id" | "platform_user_id" | "username" | "display_name" | "profile_image_url" | "updated_at"
      >
    >) {
      const normalized = this.normalizeCachedProfile(row);
      if (normalized) {
        profiles.set(Number(row.user_id), normalized);
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

    const { data, error } = await supabase
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

  private async countUsers() {
    const { count, error } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true });

    if (error) {
      throw new Error(`Count users: ${error.message}`);
    }

    return count ?? 0;
  }

  private async getReferralAggregateMaps() {
    const referralRows = await this.fetchAllPages<{ referrer_id: number | null }>(
      async (from, to) =>
        await supabase
          .from("referrals")
          .select("referrer_id")
          .not("referrer_id", "is", null)
          .range(from, to)
    );

    const referralPointRows = await this.fetchAllPages<{
      user_id: number | null;
      total_awarded: number | null;
    }>(
      async (from, to) =>
        await supabase
          .from("point_events")
          .select("user_id,total_awarded")
          .in("action", ["referral_commission", "referral_new_user"])
          .not("user_id", "is", null)
          .range(from, to)
    );

    const referredUsersByUser = new Map<number, number>();
    for (const row of referralRows) {
      const userId = Number(row.referrer_id);
      if (!Number.isFinite(userId)) {
        continue;
      }

      referredUsersByUser.set(userId, (referredUsersByUser.get(userId) || 0) + 1);
    }

    const referralPointsByUser = new Map<number, number>();
    for (const row of referralPointRows) {
      const userId = Number(row.user_id);
      if (!Number.isFinite(userId)) {
        continue;
      }

      referralPointsByUser.set(
        userId,
        (referralPointsByUser.get(userId) || 0) + Number(row.total_awarded || 0)
      );
    }

    return {
      referredUsersByUser,
      referralPointsByUser,
    };
  }

  private async getSwapVolumeMap() {
    const swapRows = await this.fetchAllPages<{
      user_id: number | null;
      output_value_usd: number | string | null;
    }>(
      async (from, to) =>
        await supabase
          .from("sweep_history")
          .select("user_id,output_value_usd")
          .eq("type", "swap")
          .not("user_id", "is", null)
          .range(from, to)
    );

    const swapVolumeByUser = new Map<number, number>();
    for (const row of swapRows) {
      const userId = Number(row.user_id);
      if (!Number.isFinite(userId)) {
        continue;
      }

      swapVolumeByUser.set(
        userId,
        (swapVolumeByUser.get(userId) || 0) + Number(row.output_value_usd || 0)
      );
    }

    return swapVolumeByUser;
  }

  private async buildViewerEntry(
    type: LeaderboardKind,
    viewerAddress?: string,
    context?: {
      referralPointsByUser?: Map<number, number>;
      referredUsersByUser?: Map<number, number>;
      swapVolumeByUser?: Map<number, number>;
    }
  ): Promise<LeaderboardEntry | null> {
    if (!viewerAddress) {
      return null;
    }

    const user = await this.getOrCreate(viewerAddress);
    const [profiles, userStats, referralStats] = await Promise.all([
      this.fetchCachedProfiles([user.id]),
      this.getUserStats(user.address),
      this.getReferralStats(user.address),
    ]);

    let rank = 1;

    if (type === "particle_points") {
      const { count } = await supabase
        .from("users")
        .select("*", { count: "exact", head: true })
        .gt("total_points", user.total_points);
      rank = (count ?? 0) + 1;
    } else if (type === "referral") {
      const viewerReferralPoints =
        context?.referralPointsByUser?.get(user.id) ?? referralStats.pointsEarned ?? 0;
      const allScores = [...(context?.referralPointsByUser?.values() ?? [])];
      rank = allScores.filter((value) => value > viewerReferralPoints).length + 1;
    } else {
      const viewerSwapVolume = context?.swapVolumeByUser?.get(user.id) ?? userStats.swapVolume ?? 0;
      const allScores = [...(context?.swapVolumeByUser?.values() ?? [])];
      rank = allScores.filter((value) => value > viewerSwapVolume).length + 1;
    }

    return {
      rank,
      userId: user.id,
      address: user.address,
      totalPoints: Number(user.total_points || 0),
      referralPoints:
        context?.referralPointsByUser?.get(user.id) ?? Number(referralStats.pointsEarned || 0),
      referredUsers:
        context?.referredUsersByUser?.get(user.id) ?? Number(referralStats.friendsJoined || 0),
      swapVolume: context?.swapVolumeByUser?.get(user.id) ?? Number(userStats.swapVolume || 0),
      profile: profiles.get(user.id) ?? null,
    };
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
    const user = await this.getOrCreate(address);
    const { error } = await supabase
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
  }

  private async updateReferralLedger(
    referrerId: number,
    refereeId: number,
    pointsAwarded: number,
    options?: { markFirstSweep?: boolean }
  ) {
    const { data: existingReferral } = await supabase
      .from("referrals")
      .select("id, referrer_earned, referee_first_sweep")
      .eq("referrer_id", referrerId)
      .eq("referee_id", refereeId)
      .maybeSingle();

    if (!existingReferral) {
      await supabase.from("referrals").insert({
        referrer_id: referrerId,
        referee_id: refereeId,
        referrer_earned: pointsAwarded,
        referee_first_sweep: Boolean(options?.markFirstSweep),
      });
      return;
    }

    await supabase
      .from("referrals")
      .update({
        referrer_earned: Number(existingReferral.referrer_earned || 0) + pointsAwarded,
        referee_first_sweep:
          Boolean(existingReferral.referee_first_sweep) || Boolean(options?.markFirstSweep),
      })
      .eq("id", Number(existingReferral.id));
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

    const { data: referrer } = await supabase
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
    options?: { applyStreakBoost?: boolean }
  ) {
    const user = await this.getOrCreate(address);
    const snapshot = buildStreakSnapshot(user);
    const applyStreakBoost = options?.applyStreakBoost ?? isBoostEligibleAction(action);
    const boostPercent = applyStreakBoost ? snapshot.boostPercent : 0;
    const multiplier = 1 + boostPercent / 100;
    const totalAwarded = Math.max(0, Math.floor(pts * multiplier));

    await supabase.from("point_events").insert({
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

    await supabase
      .from("users")
      .update({
        total_points: user.total_points + totalAwarded,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    await this.awardReferralCommission(user, address, action, totalAwarded, txHash);

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

  private async todayBasePoints(address: string, action: string): Promise<number> {
    const user = await this.getOrCreate(address);
    const start = getUtcStartOfDay();
    const { data } = await supabase
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
    priceSnapshot: DailyAssetPriceRecord
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

    if (!status.recipient || status.recipient.toLowerCase() !== STREAK_SAVE_RECIPIENT.toLowerCase()) {
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
    transaction: Awaited<ReturnType<typeof baseClient.getTransaction>>,
    requiredWei: bigint
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
          call.target.toLowerCase() === STREAK_SAVE_RECIPIENT.toLowerCase() &&
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
    asset?: SaveAsset
  ): Promise<VerifiedPayment> {
    const priceSnapshot = await this.getDailyEthPriceSnapshot();
    const ethRequiredWei = calculateEthWeiFromUsd(usdTarget, priceSnapshot.price_usd);
    const usdcRequiredUnits = getUsdcUnitsForUsd(usdTarget);

    if (asset !== "eth") {
      try {
        return await this.verifyBasePayPayment(
          normalizedAddress,
          txHash,
          usdTarget,
          priceSnapshot
        );
      } catch {
        // Fall through to raw on-chain inspection for normal EOA/ERC-20 payments.
      }
    }

    const [transaction, receipt] = await Promise.all([
      baseClient.getTransaction({ hash: txHash as `0x${string}` }),
      baseClient.getTransactionReceipt({ hash: txHash as `0x${string}` }),
    ]);

    if (receipt.status !== "success") {
      throw new Error("Payment transaction is not confirmed");
    }

    if (asset === "usdc") {
      if (transaction.from.toLowerCase() !== normalizedAddress) {
        throw new Error("Payment transaction sender does not match this wallet");
      }

      const result = this.verifyUsdcPayment(
        receipt.logs,
        normalizedAddress,
        usdcRequiredUnits
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
        ethRequiredWei
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

      const result = this.verifyEthPayment(transaction.to, transaction.value, ethRequiredWei);

      return {
        ...result,
        amountUsd: usdTarget,
        priceDate: priceSnapshot.price_date,
        ethPriceUsd: priceSnapshot.price_usd,
      };
    }

    try {
      if (transaction.from.toLowerCase() !== normalizedAddress) {
        throw new Error("Payment transaction sender does not match this wallet");
      }

      const usdcPayment = this.verifyUsdcPayment(
        receipt.logs,
        normalizedAddress,
        usdcRequiredUnits
      );

      return {
        ...usdcPayment,
        amountUsd: usdTarget,
        priceDate: priceSnapshot.price_date,
        ethPriceUsd: priceSnapshot.price_usd,
      };
    } catch {
      const ethPayment = this.verifyEthPayment(transaction.to, transaction.value, ethRequiredWei);
      return {
        ...ethPayment,
        amountUsd: usdTarget,
        priceDate: priceSnapshot.price_date,
        ethPriceUsd: priceSnapshot.price_usd,
      };
    }
  }

  private verifyEthPayment(to: string | null, value: bigint, requiredWei: bigint) {
    if (!to || to.toLowerCase() !== STREAK_SAVE_RECIPIENT.toLowerCase()) {
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
    requiredAmount: bigint
  ) {
    for (const log of logs) {
      if (String(log.address).toLowerCase() !== STREAK_SAVE_USDC_ADDRESS.toLowerCase()) {
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
          to === STREAK_SAVE_RECIPIENT.toLowerCase() &&
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

  async dailyCheckIn(address: string, txHash: string, asset?: SaveAsset) {
    const normalizedAddress = address.toLowerCase();
    const user = await this.getOrCreate(normalizedAddress);
    const snapshot = buildStreakSnapshot(user);

    if (snapshot.checkedInToday) {
      throw new Error("Already checked in today");
    }

    const payment = await this.verifyFeeTransaction(
      normalizedAddress,
      txHash,
      CFG.CHECK_IN_FEE_USD,
      asset
    );

    const nextStreak = snapshot.status === "active" ? user.current_streak + 1 : 1;
    const pointsAwarded = CFG.CHECK_IN;
    const checkInDate = getUtcDayKey(new Date());
    const nowIso = new Date().toISOString();

    await supabase.from("check_ins").insert({
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

    await supabase.from("point_events").insert({
      user_id: user.id,
      action: "daily_check_in",
      points: pointsAwarded,
      multiplier: 1,
      total_awarded: pointsAwarded,
      tx_hash: txHash,
      metadata: {
        streakDay: nextStreak,
        unlockedBoostPercent: getBoostPercent(nextStreak),
        boostAppliesTo: "self_earned_only",
        paymentAsset: payment.asset,
        paymentAmount: payment.amount,
        paymentAmountUsd: payment.amountUsd,
        priceSnapshotDate: payment.priceDate,
        ethPriceUsd: payment.ethPriceUsd,
      },
      season: 1,
    });

    const nextUser = {
      ...user,
      current_streak: nextStreak,
      longest_streak: Math.max(nextStreak, user.longest_streak),
      last_check_in: nowIso,
      total_points: user.total_points + pointsAwarded,
    } as UserRecord;

    await supabase
      .from("users")
      .update({
        current_streak: nextUser.current_streak,
        longest_streak: nextUser.longest_streak,
        last_check_in: nextUser.last_check_in,
        total_points: nextUser.total_points,
        updated_at: nowIso,
      })
      .eq("id", user.id);

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

    return {
      points: pointsAwarded,
      pointsAwarded,
      paymentAsset: payment.asset,
      paymentAmountUsd: payment.amountUsd,
      unlockedBoostPercent: getBoostPercent(nextStreak),
      ...(await this.buildBalance(nextUser)),
    };
  }

  async resetBrokenStreak(address: string) {
    const user = await this.getOrCreate(address);
    const snapshot = buildStreakSnapshot(user);

    if (!snapshot.isBroken) {
      return {
        reset: false,
        ...(await this.buildBalance(user)),
      };
    }

    const nextUser = {
      ...user,
      current_streak: 0,
    } as UserRecord;

    await supabase
      .from("users")
      .update({
        current_streak: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    return {
      reset: true,
      ...(await this.buildBalance(nextUser)),
    };
  }

  async recoverBrokenStreak(address: string, txHash: string, asset?: SaveAsset) {
    const normalizedAddress = address.toLowerCase();
    const user = await this.getOrCreate(normalizedAddress);
    const snapshot = buildStreakSnapshot(user);

    if (!snapshot.isBroken || snapshot.recoverableStreak <= 0) {
      throw new Error("No broken streak is available to restore");
    }

    const { data: existingRecovery } = await supabase
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

    await supabase.from("streak_recovery_events").insert({
      user_id: user.id,
      tx_hash: txHash,
      asset_symbol: payment.asset.toUpperCase(),
      asset_address: payment.asset === "usdc" ? STREAK_SAVE_USDC_ADDRESS : null,
      amount: payment.amount,
      amount_usd: payment.amountUsd,
      previous_streak: snapshot.recoverableStreak,
      restored_streak: snapshot.recoverableStreak,
      status: "confirmed",
    });

    const nowIso = new Date().toISOString();
    const nextUser = {
      ...user,
      last_check_in: nowIso,
    } as UserRecord;

    await supabase
      .from("users")
      .update({
        last_check_in: nowIso,
        updated_at: nowIso,
      })
      .eq("id", user.id);

    return {
      restored: true,
      txHash,
      asset: payment.asset,
      paymentAmountUsd: payment.amountUsd,
      ...(await this.buildBalance(nextUser)),
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

    if (!historyKey) {
      throw new Error("Swap transaction id required");
    }

    const { data: existingHistory, error: historyLookupError } = await supabase
      .from("sweep_history")
      .select("points_earned")
      .eq("tx_hash", historyKey)
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

    const { error } = await supabase.from("sweep_history").insert({
      user_id: user.id,
      tx_hash: historyKey,
      chain_id: input.chainId || base.id,
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

    return award.totalAwarded;
  }

  async getBalance(address: string) {
    const user = await this.getOrCreate(address);
    return this.buildBalance(user);
  }

  async getUserStats(address: string) {
    const user = await this.getOrCreate(address);
    const { data } = await supabase
      .from("sweep_history")
      .select("type, output_value_usd, token_count")
      .eq("user_id", user.id);

    let dustSwept = 0;
    let swapVolume = 0;
    let tokensBurned = 0;

    for (const row of data || []) {
      if (row.type === "sweep") {
        dustSwept += row.token_count;
      }
      if (row.type === "swap" && row.output_value_usd) {
        swapVolume += Number(row.output_value_usd);
      }
      if (row.type === "burn") {
        tokensBurned += row.token_count;
      }
    }

    return {
      totalPoints: user.total_points,
      dustSwept,
      swapVolume,
      tokensBurned,
    };
  }

  async getReferralStats(address: string) {
    const user = await this.getOrCreate(address);

    const { count } = await supabase
      .from("referrals")
      .select("*", { count: "exact", head: true })
      .eq("referrer_id", user.id);

    const { data } = await supabase
      .from("point_events")
      .select("total_awarded")
      .eq("user_id", user.id)
      .in("action", ["referral_commission", "referral_new_user"]);

    const referralPoints = (data || []).reduce(
      (sum: number, row: { total_awarded: number }) =>
        sum + Number(row.total_awarded || 0),
      0
    );

    return {
      code: user.referral_code,
      friendsJoined: count || 0,
      pointsEarned: referralPoints,
    };
  }

  async getLeaderboard(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const { data } = await supabase
      .from("users")
      .select("address,total_points,current_streak,last_check_in")
      .order("total_points", { ascending: false })
      .range(offset, offset + limit - 1);

    return (data ?? []).map(
      (
        user: {
          address: string;
          total_points: number;
          current_streak: number;
          last_check_in: string | null;
        },
        index: number
      ) => {
        const snapshot = buildStreakSnapshot({
          current_streak: user.current_streak,
          last_check_in: user.last_check_in,
        } as Pick<UserRecord, "current_streak" | "last_check_in">);

        return {
          rank: offset + index + 1,
          address: user.address,
          points: user.total_points,
          streak: snapshot.activeStreak,
          boostPercent: snapshot.boostPercent,
        };
      }
    );
  }

  async getLeaderboardHub(
    type: LeaderboardKind,
    limit = 50,
    viewerAddress?: string
  ): Promise<LeaderboardHubResponse> {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const totalUserCount = await this.countUsers();

    if (type === "particle_points") {
      const { data, error } = await supabase
        .from("users")
        .select("id,address,total_points")
        .order("total_points", { ascending: false })
        .range(0, safeLimit - 1);

      if (error) {
        throw new Error(`Load particle point leaderboard: ${error.message}`);
      }

      const topUsers = (data ?? []) as Array<Pick<UserRecord, "id" | "address" | "total_points">>;
      const profiles = await this.fetchCachedProfiles(topUsers.map((user) => Number(user.id)));
      const viewer = await this.buildViewerEntry(type, viewerAddress);

      return {
        type,
        limit: safeLimit,
        totalUserCount,
        viewer,
        entries: topUsers.map((user, index) => ({
          rank: index + 1,
          userId: Number(user.id),
          address: String(user.address),
          totalPoints: Number(user.total_points || 0),
          referralPoints: 0,
          referredUsers: 0,
          swapVolume: 0,
          profile: profiles.get(Number(user.id)) ?? null,
        })),
      };
    }

    if (type === "referral") {
      const { referredUsersByUser, referralPointsByUser } = await this.getReferralAggregateMaps();
      const sortedUserIds = [...new Set([...referredUsersByUser.keys(), ...referralPointsByUser.keys()])].sort(
        (left, right) => {
          const pointDelta =
            (referralPointsByUser.get(right) || 0) - (referralPointsByUser.get(left) || 0);
          if (pointDelta !== 0) {
            return pointDelta;
          }

          const countDelta =
            (referredUsersByUser.get(right) || 0) - (referredUsersByUser.get(left) || 0);
          if (countDelta !== 0) {
            return countDelta;
          }

          return left - right;
        }
      );

      const topIds = sortedUserIds.slice(0, safeLimit);
      const [usersById, profiles, viewer] = await Promise.all([
        this.fetchUsersByIds(topIds),
        this.fetchCachedProfiles(topIds),
        this.buildViewerEntry(type, viewerAddress, {
          referralPointsByUser,
          referredUsersByUser,
        }),
      ]);

      return {
        type,
        limit: safeLimit,
        totalUserCount,
        viewer,
        entries: topIds
          .map((userId, index) => {
            const user = usersById.get(userId);
            if (!user) {
              return null;
            }

            return {
              rank: index + 1,
              userId,
              address: user.address,
              totalPoints: Number(user.total_points || 0),
              referralPoints: referralPointsByUser.get(userId) || 0,
              referredUsers: referredUsersByUser.get(userId) || 0,
              swapVolume: 0,
              profile: profiles.get(userId) ?? null,
            } satisfies LeaderboardEntry;
          })
          .filter((entry): entry is LeaderboardEntry => Boolean(entry)),
      };
    }

    const swapVolumeByUser = await this.getSwapVolumeMap();
    const sortedUserIds = [...swapVolumeByUser.keys()].sort((left, right) => {
      const volumeDelta = (swapVolumeByUser.get(right) || 0) - (swapVolumeByUser.get(left) || 0);
      if (volumeDelta !== 0) {
        return volumeDelta;
      }

      return left - right;
    });
    const topIds = sortedUserIds.slice(0, safeLimit);
    const [usersById, profiles, viewer] = await Promise.all([
      this.fetchUsersByIds(topIds),
      this.fetchCachedProfiles(topIds),
      this.buildViewerEntry(type, viewerAddress, {
        swapVolumeByUser,
      }),
    ]);

    return {
      type,
      limit: safeLimit,
      totalUserCount,
      viewer,
      entries: topIds
        .map((userId, index) => {
          const user = usersById.get(userId);
          if (!user) {
            return null;
          }

          return {
            rank: index + 1,
            userId,
            address: user.address,
            totalPoints: Number(user.total_points || 0),
            referralPoints: 0,
            referredUsers: 0,
            swapVolume: swapVolumeByUser.get(userId) || 0,
            profile: profiles.get(userId) ?? null,
          } satisfies LeaderboardEntry;
        })
        .filter((entry): entry is LeaderboardEntry => Boolean(entry)),
    };
  }

  async applyReferral(userAddress: string, code: string): Promise<void> {
    const user = await this.getOrCreate(userAddress);
    if (user.referred_by) {
      throw new Error("Already referred");
    }

    const normalizedCode = code.trim().toUpperCase();

    const { data: referrer } = await supabase
      .from("users")
      .select("*")
      .eq("referral_code", normalizedCode)
      .single();

    if (!referrer) {
      throw new Error("Invalid referral code");
    }
    if (String((referrer as UserRecord).address).toLowerCase() === userAddress.toLowerCase()) {
      throw new Error("Cannot self-refer");
    }

    await supabase
      .from("users")
      .update({ referred_by: (referrer as UserRecord).id })
      .eq("id", user.id);
    await supabase.from("referrals").insert({
      referrer_id: (referrer as UserRecord).id,
      referee_id: user.id,
    });

    await this.addPoints(
      userAddress,
      CFG.REFERRAL_SIGNUP,
      "referral_welcome",
      undefined,
      undefined,
      { applyStreakBoost: false }
    );

    const referrerAward = await this.addPoints(
      (referrer as UserRecord).address,
      CFG.REFERRAL_SIGNUP,
      "referral_new_user",
      undefined,
      undefined,
      { applyStreakBoost: false }
    );

    await this.updateReferralLedger(
      (referrer as UserRecord).id,
      user.id,
      referrerAward.totalAwarded
    );
  }
}

export const pointsEngine = new PointsEngine();
