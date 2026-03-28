import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  parseEther,
} from "viem";
import { base } from "viem/chains";
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
  REFERRAL_COMMISSION_PCT: 10,

  STREAK_LENGTH: 30,
  STREAK_BOOST_STEP_PERCENT: 10,
  MAX_STREAK_BOOST_PERCENT: 300,
} as const;

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
const STREAK_SAVE_USDC_AMOUNT = BigInt(1_000_000);
const STREAK_SAVE_ETH_AMOUNT_WEI =
  process.env.STREAK_SAVE_ETH_AMOUNT_WEI
    ? BigInt(process.env.STREAK_SAVE_ETH_AMOUNT_WEI)
    : parseEther("0.0003");

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

function buildStreakSnapshot(user: Pick<UserRecord, "current_streak" | "last_check_in">, now = new Date()): StreakSnapshot {
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

  private async buildBalance(user: UserRecord) {
    const snapshot = buildStreakSnapshot(user);
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
      saveConfig: {
        chainId: base.id,
        recipient: STREAK_SAVE_RECIPIENT,
        usdcAddress: STREAK_SAVE_USDC_ADDRESS,
        usdcAmount: formatUnits(STREAK_SAVE_USDC_AMOUNT, 6),
        ethAmountWei: STREAK_SAVE_ETH_AMOUNT_WEI.toString(),
        ethAmountDisplay: formatUnits(STREAK_SAVE_ETH_AMOUNT_WEI, 18),
      },
    };
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

  async dailyCheckIn(address: string) {
    const user = await this.getOrCreate(address);
    const snapshot = buildStreakSnapshot(user);

    if (snapshot.checkedInToday) {
      throw new Error("Already checked in today");
    }

    const nextStreak = snapshot.status === "active" ? user.current_streak + 1 : 1;
    const pointsAwarded = CFG.CHECK_IN;
    const checkInDate = getUtcDayKey(new Date());
    const nowIso = new Date().toISOString();

    await supabase.from("check_ins").insert({
      user_id: user.id,
      check_in_date: checkInDate,
      points_earned: pointsAwarded,
      streak_day: nextStreak,
    });

    await supabase.from("point_events").insert({
      user_id: user.id,
      action: "daily_check_in",
      points: pointsAwarded,
      multiplier: 1,
      total_awarded: pointsAwarded,
      metadata: {
        streakDay: nextStreak,
        unlockedBoostPercent: getBoostPercent(nextStreak),
        boostAppliesTo: "self_earned_only",
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

    return {
      points: pointsAwarded,
      pointsAwarded,
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

    const verification = await this.verifyRecoveryTransaction(
      normalizedAddress,
      txHash,
      asset
    );

    await supabase.from("streak_recovery_events").insert({
      user_id: user.id,
      tx_hash: txHash,
      asset_symbol: verification.asset.toUpperCase(),
      asset_address:
        verification.asset === "usdc" ? STREAK_SAVE_USDC_ADDRESS : null,
      amount: verification.amount,
      amount_usd: 1,
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
      asset: verification.asset,
      ...(await this.buildBalance(nextUser)),
    };
  }

  private async verifyRecoveryTransaction(
    normalizedAddress: string,
    txHash: string,
    asset?: SaveAsset
  ) {
    const [transaction, receipt] = await Promise.all([
      baseClient.getTransaction({ hash: txHash as `0x${string}` }),
      baseClient.getTransactionReceipt({ hash: txHash as `0x${string}` }),
    ]);

    if (receipt.status !== "success") {
      throw new Error("Recovery transaction is not confirmed");
    }

    if (transaction.from.toLowerCase() !== normalizedAddress) {
      throw new Error("Recovery transaction sender does not match this wallet");
    }

    if (asset === "usdc") {
      return this.verifyUsdcRecovery(receipt.logs, normalizedAddress);
    }

    if (asset === "eth") {
      return this.verifyEthRecovery(transaction.to, transaction.value);
    }

    try {
      return this.verifyUsdcRecovery(receipt.logs, normalizedAddress);
    } catch {
      return this.verifyEthRecovery(transaction.to, transaction.value);
    }
  }

  private verifyEthRecovery(to: string | null, value: bigint) {
    if (!to || to.toLowerCase() !== STREAK_SAVE_RECIPIENT.toLowerCase()) {
      throw new Error("ETH recovery payment was not sent to the save wallet");
    }

    if (value < STREAK_SAVE_ETH_AMOUNT_WEI) {
      throw new Error("ETH recovery payment is below the required amount");
    }

    return {
      asset: "eth" as const,
      amount: value.toString(),
    };
  }

  private verifyUsdcRecovery(logs: readonly any[], normalizedAddress: string) {
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
          value >= STREAK_SAVE_USDC_AMOUNT
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

    throw new Error("USDC recovery payment was not found in this transaction");
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

    const user = award.user;
    if (user.referred_by) {
      const { data: ref } = await supabase
        .from("users")
        .select("address")
        .eq("id", user.referred_by)
        .single();

      if (ref) {
        await this.addPoints(
          String((ref as { address: string }).address),
          Math.floor((award.totalAwarded * CFG.REFERRAL_COMMISSION_PCT) / 100),
          "referral_commission",
          txHash,
          {
            sourceAction: "dust_sweep",
            sourceAddress: address.toLowerCase(),
          },
          { applyStreakBoost: false }
        );
      }
    }

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

  async recordSwap(address: string, txHash: string): Promise<number> {
    const today = await this.todayBasePoints(address, "swap");
    const capped = Math.max(0, Math.min(CFG.SWAP, CFG.CAP_SWAP - today));
    if (capped <= 0) {
      return 0;
    }

    const award = await this.addPoints(address, capped, "swap", txHash);
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

  async applyReferral(userAddress: string, code: string): Promise<void> {
    const user = await this.getOrCreate(userAddress);
    if (user.referred_by) {
      throw new Error("Already referred");
    }

    const { data: referrer } = await supabase
      .from("users")
      .select("*")
      .eq("referral_code", code)
      .single();

    if (!referrer) {
      throw new Error("Invalid referral code");
    }
    if (String((referrer as UserRecord).address).toLowerCase() === userAddress.toLowerCase()) {
      throw new Error("Cannot self-refer");
    }

    await supabase.from("users").update({ referred_by: (referrer as UserRecord).id }).eq("id", user.id);
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
    await this.addPoints(
      (referrer as UserRecord).address,
      CFG.REFERRAL_SIGNUP,
      "referral_new_user",
      undefined,
      undefined,
      { applyStreakBoost: false }
    );
  }
}

export const pointsEngine = new PointsEngine();
