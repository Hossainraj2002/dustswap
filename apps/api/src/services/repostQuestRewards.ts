import type { PoolClient } from "pg";
import { dbQuery, getDbPool } from "../lib/db";
import { postgresDb } from "./postgres";

type QuestRow = {
  id: string;
  slug: string;
  title: string;
};

type PendingProgressRow = {
  id: number;
  quest_id: string;
  user_id: number;
  cycle_key: string;
  created_at: string;
};

export type AwardPendingRepostQuestsOptions = {
  dryRun?: boolean;
  limit?: number | null;
  slugs?: string[] | null;
  cutoff?: Date | string | null;
  source?: string;
};

export type AwardPendingRepostQuestsResult = {
  dryRun: boolean;
  locked: boolean;
  pendingCount: number;
  completed: number;
  awardedPoints: number;
  failed: number;
  quests: string[];
  cutoff: string | null;
};

const PAGE_SIZE = 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RUN_HOUR_UTC = 0;
const DEFAULT_RUN_MINUTE_UTC = 0;
const STARTUP_CATCHUP_DELAY_MS = 15_000;
const REPOST_REVIEW_LOCK_CLASS_ID = 0x44535750;
const REPOST_REVIEW_LOCK_OBJECT_ID = 0x52505744;
const REFERRAL_COMMISSION_PCT = Number(process.env.REFERRAL_COMMISSION_PCT || "20");
const REFERRAL_FOUNDER_PASS_CONTRACT = process.env.REFERRAL_FOUNDER_PASS_CONTRACT || "";
const REFERRAL_FOUNDER_PASS_BONUS_PCT = Number(
  process.env.REFERRAL_FOUNDER_PASS_BONUS_PCT || "60"
);
const REFERRAL_COFOUNDER_PASS_CONTRACT = process.env.REFERRAL_COFOUNDER_PASS_CONTRACT || "";
const REFERRAL_COFOUNDER_PASS_BONUS_PCT = Number(
  process.env.REFERRAL_COFOUNDER_PASS_BONUS_PCT || "30"
);

type BatchAwardSummary = {
  completed: number;
  awarded_points: number;
  referral_awarded_points: number;
};

function isEnabled(value: string | undefined, fallback: boolean) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function getRunHourUtc() {
  const value = Number(process.env.X_REPOST_REVIEW_RUN_HOUR_UTC ?? DEFAULT_RUN_HOUR_UTC);
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    return DEFAULT_RUN_HOUR_UTC;
  }
  return value;
}

function getRunMinuteUtc() {
  const value = Number(process.env.X_REPOST_REVIEW_RUN_MINUTE_UTC ?? DEFAULT_RUN_MINUTE_UTC);
  if (!Number.isInteger(value) || value < 0 || value > 59) {
    return DEFAULT_RUN_MINUTE_UTC;
  }
  return value;
}

function getConfiguredSlugs(slugs?: string[] | null) {
  if (slugs?.length) {
    return slugs.map((slug) => slug.trim()).filter(Boolean);
  }

  return (process.env.X_REPOST_REVIEW_SLUGS || "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
}

function normalizeCutoff(cutoff?: Date | string | null) {
  if (!cutoff) {
    return null;
  }

  const date = cutoff instanceof Date ? cutoff : new Date(cutoff);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid repost review cutoff");
  }

  return date.toISOString();
}

function getUtcDayStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getNextUtcRunAt(date = new Date()) {
  const runAt = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      getRunHourUtc(),
      getRunMinuteUtc(),
      0,
      0
    )
  );

  if (runAt.getTime() <= date.getTime()) {
    runAt.setTime(runAt.getTime() + MS_PER_DAY);
  }

  return runAt;
}

async function withRepostReviewLock<T>(
  onSkipped: () => T,
  callback: () => Promise<T>
) {
  const client = await getDbPool().connect();
  try {
    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [REPOST_REVIEW_LOCK_CLASS_ID, REPOST_REVIEW_LOCK_OBJECT_ID]
    );

    if (!lockResult.rows[0]?.locked) {
      return onSkipped();
    }

    try {
      return await callback();
    } finally {
      await unlockRepostReview(client);
    }
  } finally {
    client.release();
  }
}

async function unlockRepostReview(client: PoolClient) {
  try {
    await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
      REPOST_REVIEW_LOCK_CLASS_ID,
      REPOST_REVIEW_LOCK_OBJECT_ID,
    ]);
  } catch (error) {
    console.error("[Repost Quest Rewards] Failed to release advisory lock", error);
  }
}

async function fetchRepostQuests(slugs: string[]) {
  let query = postgresDb
    .from("quests")
    .select("id, slug, title")
    .eq("platform", "x")
    .eq("action_type", "repost");

  if (slugs.length > 0) {
    query = query.in("slug", slugs);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Load repost quests: ${error.message}`);
  }

  return (data || []) as QuestRow[];
}

async function fetchPendingRows(
  questIds: string[],
  limit: number | null,
  cutoffIso: string | null
) {
  const rows: PendingProgressRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const to = limit ? Math.min(from + PAGE_SIZE - 1, limit - 1) : from + PAGE_SIZE - 1;
    let query = postgresDb
      .from("quest_progress")
      .select("id, quest_id, user_id, cycle_key, created_at")
      .in("quest_id", questIds)
      .eq("status", "pending_review")
      .is("completed_at", null)
      .is("rewarded_at", null)
      .order("created_at", { ascending: true })
      .range(from, to);

    if (cutoffIso) {
      query = query.lte("created_at", cutoffIso);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Load pending repost progress: ${error.message}`);
    }

    rows.push(...((data || []) as PendingProgressRow[]));
    if (!data || data.length < PAGE_SIZE || (limit && rows.length >= limit)) {
      return limit ? rows.slice(0, limit) : rows;
    }
  }
}

function chunkRows<T>(rows: T[], chunkSize: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

function getUtcDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getYesterdayUtcKey(date: Date) {
  const yesterday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return getUtcDayKey(yesterday);
}

async function awardPendingRowsBatch(rows: PendingProgressRow[], source: string) {
  const totals = {
    completed: 0,
    awardedPoints: 0,
    referralAwardedPoints: 0,
  };

  for (const chunk of chunkRows(rows, PAGE_SIZE)) {
    const now = new Date();
    const progressIds = chunk.map((row) => row.id);
    const queryResult = await dbQuery<BatchAwardSummary>(
      `
      WITH candidates AS (
        SELECT
          qp.id AS progress_id,
          qp.user_id,
          qp.quest_id,
          qp.cycle_key,
          qp.progress,
          qp.metadata AS progress_metadata,
          qp.completed_at AS existing_completed_at,
          qp.verified_by_api AS existing_verified_by_api,
          qp.verified_at AS existing_verified_at,
          q.slug,
          q.campaign_key,
          q.category,
          q.platform,
          q.verification_type,
          q.reward_points::integer AS reward_points,
          q.target_value::numeric AS target_value,
          u.address,
          u.referred_by,
          u.current_streak,
          u.last_check_in
        FROM quest_progress qp
        JOIN quests q ON q.id = qp.quest_id
        JOIN users u ON u.id = qp.user_id
        WHERE qp.id = ANY($1::bigint[])
          AND qp.status = 'pending_review'
          AND qp.completed_at IS NULL
          AND qp.rewarded_at IS NULL
          AND q.platform = 'x'
          AND q.action_type = 'repost'
      ),
      awards AS (
        SELECT
          c.*,
          CASE
            WHEN c.current_streak > 0
              AND c.last_check_in IS NOT NULL
              AND to_char(c.last_check_in, 'YYYY-MM-DD') IN ($3, $4)
            THEN c.current_streak
            ELSE 0
          END AS active_streak,
          LEAST(
            300,
            CASE
              WHEN c.current_streak > 0
                AND c.last_check_in IS NOT NULL
                AND to_char(c.last_check_in, 'YYYY-MM-DD') IN ($3, $4)
              THEN c.current_streak * 10
              ELSE 0
            END
          ) AS boost_percent
        FROM candidates c
      ),
      computed AS (
        SELECT
          a.*,
          (1 + (a.boost_percent::numeric / 100.0)) AS multiplier,
          GREATEST(0, FLOOR(a.reward_points * (1 + (a.boost_percent::numeric / 100.0))))::integer AS total_awarded
        FROM awards a
      ),
      updated_progress AS (
        UPDATE quest_progress qp
        SET
          status = 'completed',
          progress = GREATEST(qp.progress, c.target_value),
          target_value = c.target_value,
          completed_at = COALESCE(qp.completed_at, $2::timestamptz),
          rewarded_at = $2::timestamptz,
          verified_by_api = COALESCE(c.existing_verified_by_api, false),
          verified_at = c.existing_verified_at,
          metadata = COALESCE(qp.metadata, '{}'::jsonb)
            || jsonb_build_object(
              'verificationType', c.verification_type,
              'review_status', 'approved',
              'reviewed_at', $2,
              'review_provider', 'daily_pending_review',
              'review_mode', 'opened_task',
              'review_source', $5::text,
              'verified_by_api', false,
              'completedAt', $2
            ),
          updated_at = $2::timestamptz
        FROM computed c
        WHERE qp.id = c.progress_id
          AND qp.status = 'pending_review'
          AND qp.completed_at IS NULL
          AND qp.rewarded_at IS NULL
        RETURNING
          c.progress_id,
          c.user_id,
          c.quest_id,
          c.cycle_key,
          c.slug,
          c.campaign_key,
          c.category,
          c.platform,
          c.address,
          c.referred_by,
          c.reward_points,
          c.target_value,
          c.active_streak,
          c.boost_percent,
          c.multiplier,
          c.total_awarded
      ),
      point_events_inserted AS (
        INSERT INTO point_events (
          user_id,
          action,
          points,
          multiplier,
          total_awarded,
          metadata,
          season,
          created_at
        )
        SELECT
          up.user_id,
          'quest_completion',
          up.reward_points,
          up.multiplier,
          up.total_awarded,
          jsonb_build_object(
            'questId', up.quest_id,
            'questSlug', up.slug,
            'cycleKey', up.cycle_key,
            'campaignKey', up.campaign_key,
            'category', up.category,
            'platform', up.platform,
            'boostPercent', up.boost_percent,
            'streakAtAward', up.active_streak,
            'boostApplied', true
          ),
          1,
          $2::timestamp
        FROM updated_progress up
        WHERE up.reward_points > 0
        RETURNING user_id, total_awarded
      ),
      user_point_totals AS (
        SELECT user_id, SUM(total_awarded)::bigint AS total_awarded
        FROM point_events_inserted
        GROUP BY user_id
      ),
      users_updated AS (
        UPDATE users u
        SET
          total_points = u.total_points + upt.total_awarded,
          updated_at = $2::timestamp
        FROM user_point_totals upt
        WHERE u.id = upt.user_id
        RETURNING u.id
      ),
      review_logs_inserted AS (
        INSERT INTO quest_verification_logs (
          user_id,
          quest_id,
          cycle_key,
          status,
          request_payload,
          response_payload,
          created_at
        )
        SELECT
          up.user_id,
          up.quest_id,
          up.cycle_key,
          'completed',
          jsonb_build_object(
            'actionType', 'repost',
            'verificationType', 'daily_pending_review',
            'reviewMode', 'opened_task',
            'source', $5::text
          ),
          jsonb_build_object(
            'questSlug', up.slug,
            'awardedPoints', up.total_awarded,
            'verifiedByApi', false
          ),
          $2::timestamptz
        FROM updated_progress up
        RETURNING id
      ),
      referral_candidates AS (
        SELECT
          up.user_id AS referee_id,
          up.address AS referee_address,
          up.referred_by AS referrer_id,
          up.total_awarded AS source_points_awarded
        FROM updated_progress up
        WHERE up.referred_by IS NOT NULL
          AND up.total_awarded > 0
      ),
      referral_awards AS (
        SELECT
          rc.referee_id,
          rc.referee_address,
          rc.referrer_id,
          referrer.address AS referrer_address,
          rc.source_points_awarded,
          FLOOR(rc.source_points_awarded * ($6::numeric / 100.0))::integer AS commission_points,
          CASE
            WHEN referrer.current_streak > 0
              AND referrer.last_check_in IS NOT NULL
              AND to_char(referrer.last_check_in, 'YYYY-MM-DD') IN ($3, $4)
            THEN referrer.current_streak
            ELSE 0
          END AS referrer_active_streak
        FROM referral_candidates rc
        JOIN users referrer ON referrer.id = rc.referrer_id
      ),
      referral_events_inserted AS (
        INSERT INTO point_events (
          user_id,
          action,
          points,
          multiplier,
          total_awarded,
          metadata,
          season,
          created_at
        )
        SELECT
          ra.referrer_id,
          'referral_commission',
          ra.commission_points,
          1,
          ra.commission_points,
          jsonb_build_object(
            'sourceAction', 'quest_completion',
            'sourceAddress', lower(ra.referee_address),
            'sourcePointsAwarded', ra.source_points_awarded,
            'commissionPct', $6::numeric,
            'founderPassContract', NULLIF($7::text, ''),
            'founderPassBonusPct', $8::numeric,
            'cofounderPassContract', NULLIF($9::text, ''),
            'cofounderPassBonusPct', $10::numeric,
            'boostPercent', 0,
            'streakAtAward', ra.referrer_active_streak,
            'boostApplied', false
          ),
          1,
          $2::timestamp
        FROM referral_awards ra
        WHERE ra.commission_points > 0
        RETURNING user_id, total_awarded
      ),
      referral_user_totals AS (
        SELECT user_id, SUM(total_awarded)::bigint AS total_awarded
        FROM referral_events_inserted
        GROUP BY user_id
      ),
      referral_users_updated AS (
        UPDATE users u
        SET
          total_points = u.total_points + rut.total_awarded,
          updated_at = $2::timestamp
        FROM referral_user_totals rut
        WHERE u.id = rut.user_id
        RETURNING u.id
      ),
      referral_ledger_totals AS (
        SELECT
          ra.referrer_id,
          ra.referee_id,
          SUM(ra.commission_points)::bigint AS commission_points
        FROM referral_awards ra
        WHERE ra.commission_points > 0
        GROUP BY ra.referrer_id, ra.referee_id
      ),
      referral_ledger_updated AS (
        UPDATE referrals r
        SET referrer_earned = r.referrer_earned + rlt.commission_points
        FROM referral_ledger_totals rlt
        WHERE r.referrer_id = rlt.referrer_id
          AND r.referee_id = rlt.referee_id
        RETURNING r.id
      )
      SELECT
        COUNT(*)::integer AS completed,
        COALESCE(SUM(total_awarded), 0)::integer AS awarded_points,
        COALESCE((SELECT SUM(total_awarded)::integer FROM referral_events_inserted), 0)::integer AS referral_awarded_points
      FROM updated_progress
      `,
      [
        progressIds,
        now.toISOString(),
        getUtcDayKey(now),
        getYesterdayUtcKey(now),
        source,
        REFERRAL_COMMISSION_PCT,
        REFERRAL_FOUNDER_PASS_CONTRACT,
        REFERRAL_FOUNDER_PASS_BONUS_PCT,
        REFERRAL_COFOUNDER_PASS_CONTRACT,
        REFERRAL_COFOUNDER_PASS_BONUS_PCT,
      ]
    );

    const summary = queryResult.rows[0];
    totals.completed += Number(summary?.completed || 0);
    totals.awardedPoints += Number(summary?.awarded_points || 0);
    totals.referralAwardedPoints += Number(summary?.referral_awarded_points || 0);
  }

  return totals;
}

export async function awardPendingRepostQuests(
  options: AwardPendingRepostQuestsOptions = {}
): Promise<AwardPendingRepostQuestsResult> {
  const dryRun = Boolean(options.dryRun);
  const slugs = getConfiguredSlugs(options.slugs);
  const cutoffIso = normalizeCutoff(options.cutoff);
  const source = options.source || (dryRun ? "script_dry_run" : "script");
  const limit =
    options.limit && Number.isInteger(options.limit)
      ? Math.max(1, Number(options.limit))
      : null;

  return withRepostReviewLock(
    () => ({
      dryRun,
      locked: false,
      pendingCount: 0,
      completed: 0,
      awardedPoints: 0,
      failed: 0,
      quests: [],
      cutoff: cutoffIso,
    }),
    async () => {
      const quests = await fetchRepostQuests(slugs);
      const questById = new Map(quests.map((quest) => [quest.id, quest]));

      if (quests.length === 0) {
        return {
          dryRun,
          locked: true,
          pendingCount: 0,
          completed: 0,
          awardedPoints: 0,
          failed: 0,
          quests: [],
          cutoff: cutoffIso,
        };
      }

      const pendingRows = await fetchPendingRows(
        quests.map((quest) => quest.id),
        limit,
        cutoffIso
      );

      const result: AwardPendingRepostQuestsResult = {
        dryRun,
        locked: true,
        pendingCount: pendingRows.length,
        completed: 0,
        awardedPoints: 0,
        failed: 0,
        quests: quests.map((quest) => quest.slug),
        cutoff: cutoffIso,
      };

      if (dryRun) {
        for (const row of pendingRows) {
          const quest = questById.get(row.quest_id);
          if (!quest) {
            result.failed += 1;
            console.warn(`Skipping progress ${row.id}: quest not found in active repost set`);
            continue;
          }

          result.completed += 1;
        }
      } else {
        const batchResult = await awardPendingRowsBatch(pendingRows, source);
        result.completed = batchResult.completed;
        result.awardedPoints = batchResult.awardedPoints;
      }

      return result;
    }
  );
}

class RepostQuestRewardScheduler {
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;

  start() {
    if (!isEnabled(process.env.X_REPOST_REVIEW_SCHEDULER_ENABLED, true)) {
      console.log("[Repost Quest Rewards] Scheduler disabled");
      return;
    }

    if (this.timer || this.startupTimer) {
      return;
    }

    if (isEnabled(process.env.X_REPOST_REVIEW_STARTUP_CATCHUP_ENABLED, true)) {
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        void this.runStartupCatchup();
      }, STARTUP_CATCHUP_DELAY_MS);
      this.startupTimer.unref?.();
    }

    this.scheduleNext();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private scheduleNext() {
    const runAt = getNextUtcRunAt();
    const delayMs = Math.max(1_000, runAt.getTime() - Date.now());

    console.log(`[Repost Quest Rewards] Next daily run at ${runAt.toISOString()}`);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduled();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runStartupCatchup() {
    const cutoff = getUtcDayStart();
    await this.run("startup_catchup", cutoff);
  }

  private async runScheduled() {
    try {
      await this.run("daily_utc_scheduler", new Date());
    } finally {
      this.scheduleNext();
    }
  }

  private async run(source: string, cutoff: Date) {
    try {
      const result = await awardPendingRepostQuests({
        source,
        cutoff,
      });

      if (!result.locked) {
        console.log("[Repost Quest Rewards] Run skipped because another worker holds the lock");
        return;
      }

      console.log(
        `[Repost Quest Rewards] ${source} completed: pending=${result.pendingCount} completed=${result.completed} awarded_points=${result.awardedPoints} failed=${result.failed} cutoff=${result.cutoff}`
      );
    } catch (error) {
      console.error(`[Repost Quest Rewards] ${source} failed`, error);
    }
  }
}

export const repostQuestRewardScheduler = new RepostQuestRewardScheduler();
