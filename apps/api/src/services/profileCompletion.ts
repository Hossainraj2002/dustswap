import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { createPublicClient, getAddress, http, isAddress, type Hex } from "viem";
import { base } from "viem/chains";
import { isAllowedAppDomain } from "../config/appOrigins";
import { dbQuery, getDbPool } from "../lib/db";
import { runtimeCache } from "../utils/runtimeCache";
import { pointsEngine } from "./pointsEngine";
import { postgresDb } from "./postgres";
import { isConnectedXAccount, type XSocialAccountRecord } from "./xVerification";

const GUIDE_KEY = "profile_complete" as const;
const GUIDE_VERSION = 1 as const;
const REWARD_ACTION = "profile_completion_reward_v1";
const REWARD_POINTS = 1000;
const PROFILE_COMPLETION_STATEMENT = "DustSwap Profile Completion";
const PROFILE_COMPLETION_SIGNATURE_TTL_MS = 5 * 60 * 1000;
const PROFILE_COMPLETION_FUTURE_SKEW_MS = 60 * 1000;
const PROFILE_COMPLETION_CLAIM_WINDOW_MS = 60 * 1000;
const PROFILE_COMPLETION_CLAIM_LIMIT = 6;

export type ProfileCompletionStepKey =
  | "add_referral"
  | "connect_x"
  | "connect_discord";
export type ProfileCompletionNextStep =
  | ProfileCompletionStepKey
  | "claim_reward"
  | null;

type GuideSurface = "tracker" | "modal";

type UserRow = {
  id: number;
  address: string;
  referred_by: number | null;
  total_points: number;
};

type ReferralLedgerRow = {
  referrer_id: number | null;
};

type SocialAccountRow = {
  platform: string;
  platform_user_id: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  metadata: Record<string, unknown> | null;
} & Partial<XSocialAccountRecord>;

type GuideStateRow = {
  wallet_address: string;
  guide_key: string;
  guide_version: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  modal_impression_count: number;
  dismiss_count: number;
  completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type RewardClaimEventRow = {
  id: number | string;
  total_awarded: number | string | null;
  points: number | string | null;
  created_at: string | null;
};

type ProfileCompletionDerivedState = {
  referralComplete: boolean;
  xComplete: boolean;
  discordComplete: boolean;
};

export type ProfileCompletionGuide = {
  key: typeof GUIDE_KEY;
  version: typeof GUIDE_VERSION;
  completionPercent: number;
  completedSteps: number;
  totalSteps: 3;
  nextStep: ProfileCompletionNextStep;
  rewardClaimed: boolean;
  canClaimReward: boolean;
  showModal: boolean;
  steps: Array<{
    key: ProfileCompletionStepKey;
    label: string;
    status: "complete" | "incomplete";
  }>;
};

export type ProfileCompletionAuthAction = "claim-profile-completion";

export type ProfileCompletionAuthInput = {
  address?: string;
  message?: string;
  signature?: Hex;
};

export class ProfileCompletionError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

const publicClient = createPublicClient({
  chain: base,
  transport: http(
    process.env.BASE_RPC_URL ||
      process.env.NEXT_PUBLIC_BASE_RPC_URL ||
      "https://mainnet.base.org"
  ),
});

function normalizeAddress(address: string) {
  if (!isAddress(address)) {
    throw new ProfileCompletionError("A valid wallet address is required.", 400);
  }

  return getAddress(address).toLowerCase();
}

function parseProfileCompletionMessage(message: string) {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== PROFILE_COMPLETION_STATEMENT) {
    throw new ProfileCompletionError("Invalid profile completion message.", 401);
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

function normalizeGuideSurface(value: unknown): GuideSurface {
  return value === "modal" ? "modal" : "tracker";
}

function normalizeGuideStateRow(
  row: Partial<GuideStateRow> | null
): GuideStateRow | null {
  if (!row) {
    return null;
  }

  return {
    wallet_address: String(row.wallet_address || "").toLowerCase(),
    guide_key: String(row.guide_key || GUIDE_KEY),
    guide_version: Number(row.guide_version || GUIDE_VERSION),
    first_seen_at: row.first_seen_at || null,
    last_seen_at: row.last_seen_at || null,
    modal_impression_count: Number(row.modal_impression_count || 0),
    dismiss_count: Number(row.dismiss_count || 0),
    completed_at: row.completed_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function normalizeUserRow(row: Partial<UserRow> | null): UserRow | null {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id || 0),
    address: String(row.address || "").toLowerCase(),
    referred_by: row.referred_by == null ? null : Number(row.referred_by),
    total_points: Number(row.total_points || 0),
  };
}

function getCompletionPercent(completedSteps: number) {
  return Math.round((completedSteps / 3) * 100);
}

function getGuideSteps(derived: ProfileCompletionDerivedState) {
  return [
    {
      key: "add_referral",
      label: "Add referral",
      status: derived.referralComplete ? "complete" : "incomplete",
    },
    {
      key: "connect_x",
      label: "Connect X",
      status: derived.xComplete ? "complete" : "incomplete",
    },
    {
      key: "connect_discord",
      label: "Connect Discord",
      status: derived.discordComplete ? "complete" : "incomplete",
    },
  ] satisfies ProfileCompletionGuide["steps"];
}

function getNextStep(steps: ProfileCompletionGuide["steps"], rewardClaimed: boolean) {
  const firstIncomplete = steps.find((step) => step.status === "incomplete");
  if (firstIncomplete) {
    return firstIncomplete.key;
  }

  return rewardClaimed ? null : "claim_reward";
}

export class ProfileCompletionService {
  private async loadUserByAddress(address: string) {
    const { data, error } = await postgresDb
      .from<UserRow>("users")
      .select("id, address, referred_by, total_points")
      .eq("address", address)
      .maybeSingle();

    if (error) {
      throw new ProfileCompletionError(`Failed to load profile completion user: ${error.message}`, 500);
    }

    return normalizeUserRow(data as UserRow | null);
  }

  private async loadGuideState(address: string) {
    const { data, error } = await postgresDb
      .from<GuideStateRow>("user_onboarding_guides")
      .select("*")
      .eq("wallet_address", address)
      .eq("guide_key", GUIDE_KEY)
      .maybeSingle();

    if (error) {
      throw new ProfileCompletionError(`Failed to load guide state: ${error.message}`, 500);
    }

    return normalizeGuideStateRow(data as GuideStateRow | null);
  }

  private async loadReferralLedger(refereeId: number) {
    const { data, error } = await postgresDb
      .from<ReferralLedgerRow>("referrals")
      .select("referrer_id")
      .eq("referee_id", refereeId)
      .maybeSingle();

    if (error) {
      throw new ProfileCompletionError(`Failed to load referral state: ${error.message}`, 500);
    }

    return (data as ReferralLedgerRow | null) ?? null;
  }

  private async loadSocialAccounts(userId: number) {
    const { data, error } = await postgresDb
      .from<SocialAccountRow>("social_accounts")
      .select(
        "platform, platform_user_id, username, display_name, profile_image_url, metadata"
      )
      .eq("user_id", userId)
      .in("platform", ["x", "discord"]);

    if (error) {
      throw new ProfileCompletionError(`Failed to load social account state: ${error.message}`, 500);
    }

    return (data || []) as SocialAccountRow[];
  }

  private async loadRewardClaimEvent(userId: number) {
    const { data, error } = await postgresDb
      .from<RewardClaimEventRow>("point_events")
      .select("id, points, total_awarded, created_at")
      .eq("user_id", userId)
      .eq("action", REWARD_ACTION)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new ProfileCompletionError(`Failed to load reward claim state: ${error.message}`, 500);
    }

    return (data as RewardClaimEventRow | null) ?? null;
  }

  private async deriveStateForUser(user: UserRow): Promise<ProfileCompletionDerivedState> {
    const [ledger, socialAccounts] = await Promise.all([
      this.loadReferralLedger(user.id),
      this.loadSocialAccounts(user.id),
    ]);
    const xAccount =
      socialAccounts.find((account) => account.platform === "x") || null;
    const discordAccount =
      socialAccounts.find((account) => account.platform === "discord") || null;

    return {
      referralComplete: Boolean(user.referred_by || ledger?.referrer_id),
      xComplete: Boolean(
        xAccount &&
          isConnectedXAccount({
            platform_user_id: xAccount.platform_user_id,
            metadata: xAccount.metadata || {},
          })
      ),
      discordComplete: Boolean(discordAccount?.platform_user_id),
    };
  }

  private buildGuide(args: {
    state: ProfileCompletionDerivedState;
    rewardClaimed: boolean;
    guideState: GuideStateRow | null;
  }): ProfileCompletionGuide {
    const steps = getGuideSteps(args.state);
    const completedSteps = steps.filter((step) => step.status === "complete").length;
    const allComplete = completedSteps === steps.length;

    return {
      key: GUIDE_KEY,
      version: GUIDE_VERSION,
      completionPercent: getCompletionPercent(completedSteps),
      completedSteps,
      totalSteps: 3,
      nextStep: getNextStep(steps, args.rewardClaimed),
      rewardClaimed: args.rewardClaimed,
      canClaimReward: allComplete && !args.rewardClaimed,
      showModal:
        !allComplete &&
        Number(args.guideState?.modal_impression_count || 0) === 0,
      steps,
    };
  }

  private async upsertGuideState(
    address: string,
    options?: {
      incrementModalImpressions?: number;
      incrementDismissCount?: number;
      completedAt?: string | null;
    }
  ) {
    const now = new Date().toISOString();
    const incrementModalImpressions = Math.max(
      0,
      Number(options?.incrementModalImpressions || 0)
    );
    const incrementDismissCount = Math.max(
      0,
      Number(options?.incrementDismissCount || 0)
    );
    const completedAt = options?.completedAt || null;

    await dbQuery(
      `
        INSERT INTO user_onboarding_guides (
          wallet_address,
          guide_key,
          guide_version,
          first_seen_at,
          last_seen_at,
          modal_impression_count,
          dismiss_count,
          completed_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $4, $4)
        ON CONFLICT (wallet_address, guide_key) DO UPDATE
        SET
          guide_version = EXCLUDED.guide_version,
          last_seen_at = EXCLUDED.last_seen_at,
          modal_impression_count = user_onboarding_guides.modal_impression_count + $5,
          dismiss_count = user_onboarding_guides.dismiss_count + $6,
          completed_at = COALESCE(user_onboarding_guides.completed_at, $7),
          updated_at = EXCLUDED.updated_at
      `,
      [
        address,
        GUIDE_KEY,
        GUIDE_VERSION,
        now,
        incrementModalImpressions,
        incrementDismissCount,
        completedAt,
      ]
    );
  }

  async getGuide(address: string) {
    const normalizedAddress = normalizeAddress(address);
    const [user, guideState] = await Promise.all([
      this.loadUserByAddress(normalizedAddress),
      this.loadGuideState(normalizedAddress),
    ]);

    if (!user) {
      return {
        success: true as const,
        guide: this.buildGuide({
          state: {
            referralComplete: false,
            xComplete: false,
            discordComplete: false,
          },
          rewardClaimed: false,
          guideState,
        }),
      };
    }

    const [state, rewardClaimEvent] = await Promise.all([
      this.deriveStateForUser(user),
      this.loadRewardClaimEvent(user.id),
    ]);

    return {
      success: true as const,
      guide: this.buildGuide({
        state,
        rewardClaimed: Boolean(rewardClaimEvent),
        guideState,
      }),
    };
  }

  async recordImpression(input: {
    address?: string;
    surface?: string | null;
  }) {
    if (!input.address) {
      throw new ProfileCompletionError("address is required", 400);
    }

    const normalizedAddress = normalizeAddress(input.address);
    const surface = normalizeGuideSurface(input.surface);
    await this.upsertGuideState(normalizedAddress, {
      incrementModalImpressions: surface === "modal" ? 1 : 0,
    });

    return this.getGuide(normalizedAddress);
  }

  async dismiss(input: { address?: string }) {
    if (!input.address) {
      throw new ProfileCompletionError("address is required", 400);
    }

    const normalizedAddress = normalizeAddress(input.address);
    await this.upsertGuideState(normalizedAddress, {
      incrementDismissCount: 1,
    });

    return this.getGuide(normalizedAddress);
  }

  private async assertAuthenticatedAction(
    input: ProfileCompletionAuthInput,
    expectedAction: ProfileCompletionAuthAction,
    requestIp: string
  ) {
    if (!input.address || !input.message || !input.signature) {
      throw new ProfileCompletionError(
        "address, message, and signature are required",
        400
      );
    }

    const normalizedAddress = normalizeAddress(input.address);
    const parsed = parseProfileCompletionMessage(input.message);
    const messageAddress = normalizeAddress(parsed.address);

    if (messageAddress !== normalizedAddress) {
      throw new ProfileCompletionError("Profile completion address mismatch.", 401);
    }

    if (parsed.action !== expectedAction) {
      throw new ProfileCompletionError("Invalid profile completion action.", 401);
    }

    if (!parsed.domain || !isAllowedAppDomain(parsed.domain)) {
      throw new ProfileCompletionError("Unexpected profile completion domain.", 401);
    }

    if (!parsed.nonce || parsed.nonce.length < 8 || parsed.nonce.length > 128) {
      throw new ProfileCompletionError("Invalid profile completion nonce.", 401);
    }

    const timestampMs = Date.parse(parsed.timestamp);
    const now = Date.now();
    if (!Number.isFinite(timestampMs)) {
      throw new ProfileCompletionError("Invalid profile completion timestamp.", 401);
    }

    if (now - timestampMs > PROFILE_COMPLETION_SIGNATURE_TTL_MS) {
      throw new ProfileCompletionError("Expired profile completion signature.", 401);
    }

    if (timestampMs - now > PROFILE_COMPLETION_FUTURE_SKEW_MS) {
      throw new ProfileCompletionError("Invalid profile completion timestamp.", 401);
    }

    const rateLimit = runtimeCache.consumeRateLimit(
      `profile-completion:claim:rate:${normalizedAddress}:${requestIp}`,
      PROFILE_COMPLETION_CLAIM_LIMIT,
      PROFILE_COMPLETION_CLAIM_WINDOW_MS
    );

    if (!rateLimit.allowed) {
      throw new ProfileCompletionError(
        "Profile completion claim is cooling down. Please wait.",
        429
      );
    }

    const replayKey = `profile-completion:replay:${createHash("sha256")
      .update(`${input.message}|${input.signature.toLowerCase()}`)
      .digest("hex")}`;

    if (runtimeCache.get(replayKey)) {
      throw new ProfileCompletionError(
        "Profile completion signature was already used.",
        401
      );
    }

    const valid = await publicClient.verifyMessage({
      address: normalizedAddress as `0x${string}`,
      message: input.message,
      signature: input.signature,
    });

    if (!valid) {
      throw new ProfileCompletionError("Invalid profile completion signature.", 401);
    }

    runtimeCache.set(replayKey, true, PROFILE_COMPLETION_SIGNATURE_TTL_MS);

    return {
      address: normalizedAddress,
      action: expectedAction,
    } as const;
  }

  private async deriveStateForLockedUser(
    client: PoolClient,
    user: UserRow
  ): Promise<ProfileCompletionDerivedState> {
    const [ledgerResult, socialResult] = await Promise.all([
      client.query<ReferralLedgerRow>(
        `
          SELECT referrer_id
          FROM referrals
          WHERE referee_id = $1
          LIMIT 1
        `,
        [user.id]
      ),
      client.query<SocialAccountRow>(
        `
          SELECT platform, platform_user_id, username, display_name, profile_image_url, metadata
          FROM social_accounts
          WHERE user_id = $1
            AND platform = ANY($2)
        `,
        [user.id, ["x", "discord"]]
      ),
    ]);

    const ledger = ledgerResult.rows[0] || null;
    const xAccount =
      socialResult.rows.find((account) => account.platform === "x") || null;
    const discordAccount =
      socialResult.rows.find((account) => account.platform === "discord") || null;

    return {
      referralComplete: Boolean(user.referred_by || ledger?.referrer_id),
      xComplete: Boolean(
        xAccount &&
          isConnectedXAccount({
            platform_user_id: xAccount.platform_user_id,
            metadata: xAccount.metadata || {},
          })
      ),
      discordComplete: Boolean(discordAccount?.platform_user_id),
    };
  }

  async claimReward(input: ProfileCompletionAuthInput, requestIp: string) {
    const auth = await this.assertAuthenticatedAction(
      input,
      "claim-profile-completion",
      requestIp
    );
    const pool = getDbPool();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const userResult = await client.query<UserRow>(
        `
          SELECT id, address, referred_by, total_points
          FROM users
          WHERE address = $1
          FOR UPDATE
        `,
        [auth.address]
      );
      const user = normalizeUserRow(userResult.rows[0] || null);

      if (!user) {
        throw new ProfileCompletionError(
          "Complete referral, X, and Discord before claiming this reward.",
          400
        );
      }

      const derivedState = await this.deriveStateForLockedUser(client, user);
      if (
        !derivedState.referralComplete ||
        !derivedState.xComplete ||
        !derivedState.discordComplete
      ) {
        throw new ProfileCompletionError(
          "Complete referral, X, and Discord before claiming this reward.",
          400
        );
      }

      const claimTimestamp = new Date().toISOString();
      const insertResult = await client.query<{
        id: number;
        created_at: string | null;
      }>(
        `
          INSERT INTO point_events (
            user_id,
            action,
            points,
            multiplier,
            total_awarded,
            tx_hash,
            metadata,
            season,
            created_at
          )
          VALUES ($1, $2, $3, 1, $3, NULL, $4::jsonb, 1, NOW())
          ON CONFLICT (user_id, action)
          WHERE action = '${REWARD_ACTION}'
          DO NOTHING
          RETURNING id, created_at
        `,
        [
          user.id,
          REWARD_ACTION,
          REWARD_POINTS,
          JSON.stringify({
            rewardKey: REWARD_ACTION,
            rewardLabel: "Profile completion reward",
            claimedAt: claimTimestamp,
            guideKey: GUIDE_KEY,
            guideVersion: GUIDE_VERSION,
          }),
        ]
      );

      if (insertResult.rowCount === 0) {
        await client.query("ROLLBACK");
        const guideState = await this.getGuide(auth.address);
        return {
          success: false as const,
          error: "Reward already claimed.",
          rewardClaimed: true,
          canClaimReward: false,
          guide: guideState.guide,
        };
      }

      const updatedUserResult = await client.query<{ total_points: number }>(
        `
          UPDATE users
          SET
            total_points = total_points + $2,
            updated_at = NOW()
          WHERE id = $1
          RETURNING total_points
        `,
        [user.id, REWARD_POINTS]
      );
      const totalPoints = Number(updatedUserResult.rows[0]?.total_points || 0);

      await client.query(
        `
          INSERT INTO user_onboarding_guides (
            wallet_address,
            guide_key,
            guide_version,
            first_seen_at,
            last_seen_at,
            modal_impression_count,
            dismiss_count,
            completed_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, NOW(), NOW(), 0, 0, NOW(), NOW(), NOW())
          ON CONFLICT (wallet_address, guide_key) DO UPDATE
          SET
            guide_version = EXCLUDED.guide_version,
            last_seen_at = EXCLUDED.last_seen_at,
            completed_at = COALESCE(
              user_onboarding_guides.completed_at,
              EXCLUDED.completed_at
            ),
            updated_at = EXCLUDED.updated_at
        `,
        [auth.address, GUIDE_KEY, GUIDE_VERSION]
      );

      await client.query("COMMIT");

      pointsEngine.invalidateUserReadCaches(auth.address);
      const guideState = await this.getGuide(auth.address);

      return {
        success: true as const,
        totalPoints,
        rewardClaimed: true,
        canClaimReward: false,
        claimedAt: insertResult.rows[0]?.created_at || claimTimestamp,
        guide: guideState.guide,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors so the original failure is surfaced.
      }

      if (error instanceof ProfileCompletionError) {
        throw error;
      }

      throw new ProfileCompletionError(
        error instanceof Error ? error.message : "Failed to claim reward.",
        500
      );
    } finally {
      client.release();
    }
  }
}

export const profileCompletionService = new ProfileCompletionService();
