/**
 * Audience sync, campaign dispatch, and the hourly scheduler for Base App
 * notifications.
 *
 * Safety model, in the order the guards fire:
 *
 *   NOTIFICATIONS_ENABLED        master switch, off unless explicitly set
 *   per-campaign env flag        see notificationCampaigns.ts
 *   advisory lock                one dispatcher across Railway replicas
 *   global cooldown (in SQL)     one notification per account per 24h
 *   NOTIFICATIONS_MAX_PER_RUN    hard ceiling while a campaign is new
 *   NOTIFICATIONS_DRY_RUN        writes the ledger, skips the HTTP call
 *
 * Every attempt lands in notification_sends whether it was sent, failed, or
 * dry-run, so the admin view and the cooldown both read from one place.
 */

import type { PoolClient } from "pg";
import { dbQuery, getDbPool } from "../lib/db";
import {
  BaseNotificationsError,
  fetchAudience,
  isBaseNotificationsConfigured,
  MAX_ADDRESSES_PER_SEND,
  sendNotificationBatch,
  type SendResult,
} from "./baseNotifications";
import {
  CAMPAIGNS,
  CAMPAIGN_KEYS,
  isCampaignEnabled,
  isDiscoveryMode,
  type CampaignDefinition,
  type CampaignKey,
  type CampaignRow,
  type RenderedCopy,
} from "./notificationCampaigns";

const NOTIFICATIONS_LOCK_CLASS_ID = 0x4e4f5449;
const NOTIFICATIONS_LOCK_OBJECT_ID = 0x44535750;

const SCHEDULER_TICK_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;
const DEFAULT_AUDIENCE_SYNC_HOUR_UTC = 6;

export type RunCampaignOptions = {
  dryRun?: boolean;
  source?: string;
  /** Overrides NOTIFICATIONS_MAX_PER_RUN for a single manual run. */
  maxRecipients?: number | null;
  /** Bypasses the campaign env flag for a manual admin trigger. */
  force?: boolean;
};

export type RunCampaignResult = {
  campaign: CampaignKey;
  runId: number | null;
  dryRun: boolean;
  skipped: boolean;
  skipReason?: string;
  audienceSize: number;
  targeted: number;
  capped: number;
  sentCount: number;
  failedCount: number;
  error?: string;
};

export type SyncAudienceResult = {
  skipped: boolean;
  skipReason?: string;
  fetched: number;
  enabled: number;
  disabled: number;
};

function isEnabled(value: string | undefined, fallback: boolean) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function notificationsEnabled() {
  return isEnabled(process.env.NOTIFICATIONS_ENABLED, false);
}

function isDryRun() {
  return isEnabled(process.env.NOTIFICATIONS_DRY_RUN, false);
}

/**
 * Discovery mode probes the whole user base, and only a small fraction of it
 * can actually receive anything. Leaving that uncapped means the very first
 * run after deploy fires ~165,000 sends, of which almost all come back "user
 * has not saved this app".
 *
 * That is not spam (Base delivers nothing to a non-member) but it is a terrible
 * opening move: it spends the day's whole ledger budget on strangers, and a
 * near-100% failure rate is exactly the shape of traffic an anti-abuse system
 * is built to notice. So discovery carries a conservative default cap unless an
 * explicit one is configured. Steady state stays uncapped, because there every
 * recipient is a confirmed Base App user.
 */
const DISCOVERY_DEFAULT_MAX_PER_RUN = 2_000;

function getMaxRecipientsPerRun() {
  const raw = process.env.NOTIFICATIONS_MAX_PER_RUN;

  if (raw === undefined || String(raw).trim() === "") {
    return isDiscoveryMode() ? DISCOVERY_DEFAULT_MAX_PER_RUN : null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return isDiscoveryMode() ? DISCOVERY_DEFAULT_MAX_PER_RUN : null;
  }

  return Math.floor(value);
}

function getAudienceSyncHourUtc() {
  const value = Number(
    process.env.NOTIFICATIONS_AUDIENCE_SYNC_HOUR_UTC ?? DEFAULT_AUDIENCE_SYNC_HOUR_UTC
  );

  if (!Number.isInteger(value) || value < 0 || value > 23) {
    return DEFAULT_AUDIENCE_SYNC_HOUR_UTC;
  }

  return value;
}

async function withNotificationsLock<T>(
  callback: () => Promise<T>,
  onSkipped: () => T
): Promise<T> {
  const client = await getDbPool().connect();

  try {
    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [NOTIFICATIONS_LOCK_CLASS_ID, NOTIFICATIONS_LOCK_OBJECT_ID]
    );

    if (!lockResult.rows[0]?.locked) {
      return onSkipped();
    }

    try {
      return await callback();
    } finally {
      await unlockNotifications(client);
    }
  } finally {
    client.release();
  }
}

async function unlockNotifications(client: PoolClient) {
  try {
    await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
      NOTIFICATIONS_LOCK_CLASS_ID,
      NOTIFICATIONS_LOCK_OBJECT_ID,
    ]);
  } catch (error) {
    console.error("[Notifications] Failed to release advisory lock", error);
  }
}

/**
 * Mirrors GET /app/users into notification_audience.
 *
 * Wallets that disappear from the opted-in list are flipped to
 * notifications_enabled = false rather than deleted, so the row keeps its
 * first_seen_at and the admin view can show opt-out churn.
 */
export async function syncNotificationAudience(): Promise<SyncAudienceResult> {
  if (!isBaseNotificationsConfigured()) {
    return {
      skipped: true,
      skipReason: "BASE_NOTIFICATIONS_API_KEY is not configured",
      fetched: 0,
      enabled: 0,
      disabled: 0,
    };
  }

  const users = await fetchAudience({ notificationEnabledOnly: true });
  const addresses = users.map((user) => user.address);

  if (addresses.length) {
    await dbQuery(
      `
        INSERT INTO notification_audience
          (wallet_address, app_pinned, notifications_enabled, state, source, last_synced_at)
        SELECT addr, TRUE, TRUE, 'confirmed', 'base_api', NOW()
        FROM unnest($1::text[]) AS addr
        ON CONFLICT (wallet_address) DO UPDATE
          SET app_pinned            = TRUE,
              notifications_enabled = TRUE,
              -- Must be set here. Steady-state segments select on
              -- state = 'confirmed', so leaving it at the 'unknown' default
              -- would silently exclude every newly synced opted-in wallet.
              state                 = 'confirmed',
              source                = 'base_api',
              consecutive_failures  = 0,
              last_synced_at        = NOW()
      `,
      [addresses]
    );
  }

  // An empty response would mark the entire cached audience as opted out. That
  // is the correct reading if nobody is opted in, but it is indistinguishable
  // from an upstream glitch, so we keep the cache and warn instead.
  let disabled = 0;

  if (addresses.length) {
    const { rows } = await dbQuery<{ disabled: string }>(
      `
        WITH turned_off AS (
          UPDATE notification_audience
          SET notifications_enabled = FALSE,
              -- They dropped off the opted-in list, so they are no longer
              -- confirmed. Keeping state = 'confirmed' here would leave them
              -- in every steady-state segment forever.
              state                 = CASE
                                        WHEN app_pinned THEN 'notifications_off'
                                        ELSE 'not_pinned'
                                      END,
              last_synced_at        = NOW()
          WHERE notifications_enabled = TRUE
            AND NOT (wallet_address = ANY($1::text[]))
          RETURNING 1
        )
        SELECT COUNT(*)::text AS disabled FROM turned_off
      `,
      [addresses]
    );

    disabled = Number(rows[0]?.disabled || 0);
  } else {
    console.warn(
      "[Notifications] Base returned no opted-in wallets. Keeping the cached audience rather than flagging every wallet as opted out."
    );
  }

  console.log(
    `[Notifications] Audience synced: fetched=${addresses.length} opted_out=${disabled}`
  );

  return {
    skipped: false,
    fetched: addresses.length,
    enabled: addresses.length,
    disabled,
  };
}

/**
 * Discovery mode writes one ledger row per probed wallet, and most of those are
 * failures against people who are not Base App users. Delivered sends are kept
 * forever; failures are summarised onto the audience row and then pruned, so
 * the ledger does not grow without bound.
 */
async function pruneSendLedger() {
  const keepDays = Number(process.env.NOTIFICATIONS_LEDGER_KEEP_DAYS ?? 14);
  const days = Number.isFinite(keepDays) && keepDays > 0 ? Math.floor(keepDays) : 14;

  try {
    const { rows } = await dbQuery<{ prune_notification_sends: number }>(
      "SELECT prune_notification_sends($1::int)",
      [days]
    );

    const deleted = Number(rows[0]?.prune_notification_sends || 0);
    if (deleted > 0) {
      console.log(`[Notifications] Pruned ${deleted} failed send rows older than ${days}d`);
    }
  } catch (error) {
    console.error("[Notifications] Ledger prune failed", error);
  }
}

type CopyGroup = {
  copy: RenderedCopy;
  rows: CampaignRow[];
};

/**
 * Groups rows by identical rendered copy so each distinct message costs one
 * send call per 1,000 recipients instead of one call per user.
 */
function groupByCopy(
  rows: CampaignRow[],
  campaign: CampaignDefinition,
  now: Date
): CopyGroup[] {
  const groups = new Map<string, CopyGroup>();

  for (const row of rows) {
    const copy = campaign.render(row, now);
    const key = `${copy.title} ${copy.message}`;
    const existing = groups.get(key);

    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { copy, rows: [row] });
    }
  }

  return Array.from(groups.values());
}

async function createRun(
  campaign: CampaignKey,
  source: string,
  dryRun: boolean
): Promise<number> {
  const { rows } = await dbQuery<{ id: string }>(
    `
      INSERT INTO notification_runs (campaign, source, dry_run)
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [campaign, source, dryRun]
  );

  return Number(rows[0].id);
}

async function finishRun(runId: number, result: RunCampaignResult) {
  await dbQuery(
    `
      UPDATE notification_runs
      SET audience_size = $2,
          targeted      = $3,
          capped        = $4,
          sent_count    = $5,
          failed_count  = $6,
          error         = $7,
          finished_at   = NOW()
      WHERE id = $1
    `,
    [
      runId,
      result.audienceSize,
      result.targeted,
      result.capped,
      result.sentCount,
      result.failedCount,
      result.error ?? null,
    ]
  );
}

type LedgerEntry = {
  userId: number;
  wallet: string;
  status: "sent" | "failed" | "dry_run";
  failureReason: string | null;
};

async function recordSends(
  runId: number,
  campaign: CampaignKey,
  copy: RenderedCopy,
  targetPath: string,
  entries: LedgerEntry[]
) {
  if (!entries.length) {
    return;
  }

  const values: unknown[] = [];
  const tuples = entries.map((entry, index) => {
    const base = index * 9;
    values.push(
      campaign,
      runId,
      entry.userId,
      entry.wallet,
      copy.title,
      copy.message,
      targetPath,
      entry.status,
      entry.failureReason
    );

    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  });

  await dbQuery(
    `
      INSERT INTO notification_sends
        (campaign, run_id, user_id, wallet_address, title, message, target_path, status, failure_reason)
      VALUES ${tuples.join(", ")}
    `,
    values
  );
}

/**
 * Turns Base's per-address send response into audience knowledge.
 *
 * This is the detector. On-chain classification was tried first and does not
 * work here: 3,000 wallets probed with eth_getCode across six cohorts were all
 * plain EOAs, because a Coinbase Smart Wallet that has never sent a
 * transaction is counterfactual and has no code, and DustSwap check-ins are
 * free. Base's own failure reasons are unambiguous by comparison, and they
 * arrive 1,000 wallets at a time on traffic we were sending anyway.
 *
 *   sent                          -> confirmed, notifications on
 *   "notifications disabled"      -> IS a Base App user, notifications off
 *   "not saved this app"          -> not pinned
 *
 * The middle case is the one worth catching: it proves Base App membership
 * without the user receiving anything, which makes it the cheapest possible
 * signal for who to show a "turn notifications on" prompt to.
 */
function classifyFailure(reason: string | null | undefined) {
  const text = String(reason || "").toLowerCase();

  if (text.includes("notification") && text.includes("disabl")) {
    return { state: "notifications_off", appPinned: true };
  }

  if (text.includes("not saved") || text.includes("has not saved")) {
    return { state: "not_pinned", appPinned: false };
  }

  return { state: "unknown", appPinned: false };
}

async function learnFromResults(entries: LedgerEntry[]) {
  if (!entries.length) {
    return;
  }

  const values: unknown[] = [];
  const tuples = entries.map((entry, index) => {
    const base = index * 7;
    const delivered = entry.status === "sent";
    const classified = delivered
      ? { state: "confirmed", appPinned: true }
      : classifyFailure(entry.failureReason);

    values.push(
      entry.wallet,
      entry.userId,
      classified.appPinned,
      delivered,
      classified.state,
      "send_probe",
      delivered ? new Date().toISOString() : null
    );

    // Every parameter needs an explicit cast. This is INSERT ... SELECT FROM
    // (VALUES ...), not INSERT ... VALUES, so Postgres has no target column to
    // infer from and defaults untyped parameters to text. Without the casts
    // this statement fails with "column user_id is of type integer but
    // expression is of type text" on the first real send.
    return `($${base + 1}::text, $${base + 2}::int, $${base + 3}::boolean, $${base + 4}::boolean, $${base + 5}::text, $${base + 6}::text, $${base + 7}::timestamptz)`;
  });

  await dbQuery(
    `
      INSERT INTO notification_audience
        (wallet_address, user_id, app_pinned, notifications_enabled, state, source,
         last_delivered_at, last_probe_at)
      SELECT v.wallet, v.user_id, v.app_pinned, v.enabled, v.state, v.source,
             v.delivered_at, NOW()
      FROM (VALUES ${tuples.join(", ")})
        AS v(wallet, user_id, app_pinned, enabled, state, source, delivered_at)
      ON CONFLICT (wallet_address) DO UPDATE SET
        user_id               = COALESCE(EXCLUDED.user_id, notification_audience.user_id),
        app_pinned            = EXCLUDED.app_pinned,
        notifications_enabled = EXCLUDED.notifications_enabled,
        state                 = EXCLUDED.state,
        source                = EXCLUDED.source,
        last_probe_at         = NOW(),
        last_delivered_at     = COALESCE(
                                  EXCLUDED.last_delivered_at,
                                  notification_audience.last_delivered_at
                                ),
        -- A delivery resets the counter; anything else advances it until the
        -- wallet drops out of discovery probing entirely.
        consecutive_failures  = CASE
                                  WHEN EXCLUDED.state = 'confirmed' THEN 0
                                  ELSE notification_audience.consecutive_failures + 1
                                END
    `,
    values
  );
}

async function countAudience() {
  const { rows } = await dbQuery<{ total: string }>(
    "SELECT COUNT(*)::text AS total FROM notification_audience WHERE notifications_enabled = TRUE"
  );

  return Number(rows[0]?.total || 0);
}

export async function runCampaign(
  key: CampaignKey,
  options: RunCampaignOptions = {}
): Promise<RunCampaignResult> {
  const campaign = CAMPAIGNS[key];
  const source = options.source || "manual";
  const dryRun = options.dryRun ?? isDryRun();

  const base: RunCampaignResult = {
    campaign: key,
    runId: null,
    dryRun,
    skipped: true,
    audienceSize: 0,
    targeted: 0,
    capped: 0,
    sentCount: 0,
    failedCount: 0,
  };

  if (!isBaseNotificationsConfigured()) {
    return { ...base, skipReason: "BASE_NOTIFICATIONS_API_KEY is not configured" };
  }

  if (!options.force && !isCampaignEnabled(campaign)) {
    return { ...base, skipReason: `Campaign ${key} is disabled` };
  }

  return withNotificationsLock(
    async () => {
      const runId = await createRun(key, source, dryRun);
      const now = new Date();

      const result: RunCampaignResult = {
        ...base,
        runId,
        skipped: false,
      };

      try {
        result.audienceSize = await countAudience();

        const allRows = await campaign.segment(campaign.cooldownHours);
        result.targeted = allRows.length;

        const maxRecipients =
          options.maxRecipients ?? getMaxRecipientsPerRun();

        let rows = allRows;
        if (maxRecipients !== null && allRows.length > maxRecipients) {
          rows = allRows.slice(0, maxRecipients);
          result.capped = allRows.length - rows.length;
        }

        if (!rows.length) {
          await finishRun(runId, result);
          console.log(
            `[Notifications] ${key} matched nobody (audience=${result.audienceSize})`
          );
          return result;
        }

        for (const group of groupByCopy(rows, campaign, now)) {
          for (let i = 0; i < group.rows.length; i += MAX_ADDRESSES_PER_SEND) {
            const chunk = group.rows.slice(i, i + MAX_ADDRESSES_PER_SEND);
            const byWallet = new Map(chunk.map((row) => [row.wallet, row.user_id]));

            if (dryRun) {
              await recordSends(
                runId,
                key,
                group.copy,
                campaign.targetPath,
                chunk.map((row) => ({
                  userId: row.user_id,
                  wallet: row.wallet,
                  status: "dry_run" as const,
                  failureReason: null,
                }))
              );
              continue;
            }

            const response = await sendNotificationBatch({
              walletAddresses: chunk.map((row) => row.wallet),
              title: group.copy.title,
              message: group.copy.message,
              targetPath: campaign.targetPath,
            });

            const entries = buildLedgerEntries(response.results, byWallet);
            await recordSends(
              runId,
              key,
              group.copy,
              campaign.targetPath,
              entries
            );
            await learnFromResults(entries);

            result.sentCount += entries.filter((e) => e.status === "sent").length;
            result.failedCount += entries.filter(
              (e) => e.status === "failed"
            ).length;
          }
        }

        await finishRun(runId, result);

        console.log(
          `[Notifications] ${key} ${dryRun ? "dry run" : "sent"}: audience=${result.audienceSize} targeted=${result.targeted} capped=${result.capped} sent=${result.sentCount} failed=${result.failedCount}`
        );

        return result;
      } catch (error) {
        result.error =
          error instanceof BaseNotificationsError
            ? error.message
            : (error as Error).message;

        await finishRun(runId, result).catch(() => undefined);
        console.error(`[Notifications] ${key} failed`, error);

        return result;
      }
    },
    () => ({
      ...base,
      skipReason: "Another worker holds the notifications lock",
    })
  );
}

/**
 * Maps the API response back onto our lowercase wallets. Base echoes addresses
 * in EIP-55 checksum form, and any wallet missing from the response is recorded
 * as failed rather than silently assumed delivered.
 */
function buildLedgerEntries(
  results: SendResult[],
  byWallet: Map<string, number>
): LedgerEntry[] {
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];

  for (const item of results) {
    const wallet = String(item.walletAddress || "").toLowerCase();
    const userId = byWallet.get(wallet);

    if (userId === undefined) {
      continue;
    }

    seen.add(wallet);
    entries.push({
      userId,
      wallet,
      status: item.sent ? "sent" : "failed",
      failureReason: item.sent ? null : item.failureReason || "unknown",
    });
  }

  for (const [wallet, userId] of byWallet) {
    if (seen.has(wallet)) {
      continue;
    }

    entries.push({
      userId,
      wallet,
      status: "failed",
      failureReason: "no result returned by Base",
    });
  }

  return entries;
}

/** Campaigns whose UTC hour and weekday match the given moment. */
export function getDueCampaigns(now: Date): CampaignDefinition[] {
  const hour = now.getUTCHours();
  const day = now.getUTCDay();

  return CAMPAIGN_KEYS.map((key) => CAMPAIGNS[key]).filter((campaign) => {
    if (campaign.runHourUtc !== hour) {
      return false;
    }

    return campaign.runDayOfWeekUtc === null || campaign.runDayOfWeekUtc === day;
  });
}

class NotificationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private lastTickHour: number | null = null;

  start() {
    if (!notificationsEnabled()) {
      console.log("[Notifications] Scheduler disabled");
      return;
    }

    if (!isBaseNotificationsConfigured()) {
      console.log(
        "[Notifications] Scheduler not started: BASE_NOTIFICATIONS_API_KEY is not configured"
      );
      return;
    }

    if (this.timer || this.startupTimer) {
      return;
    }

    console.log(
      `[Notifications] Scheduler started${isDryRun() ? " in dry-run mode" : ""}`
    );

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick();
      this.scheduleNext();
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
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
    // Wake shortly after the top of each UTC hour so a campaign scheduled for
    // 21:00 fires at 21:01, not 21:59.
    const now = Date.now();
    const nextHour = new Date(now);
    nextHour.setUTCMinutes(1, 0, 0);
    if (nextHour.getTime() <= now) {
      nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    }

    const delayMs = Math.max(1_000, nextHour.getTime() - now);

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.scheduleNext());
    }, Math.min(delayMs, SCHEDULER_TICK_MS));
    this.timer.unref?.();
  }

  private async tick() {
    if (!notificationsEnabled()) {
      return;
    }

    const now = new Date();
    const hour = now.getUTCHours();

    // The startup tick plus the hourly tick can land in the same hour. Without
    // this guard a restart loop would re-fire a campaign it already ran.
    if (this.lastTickHour === hour) {
      return;
    }
    this.lastTickHour = hour;

    try {
      if (hour === getAudienceSyncHourUtc()) {
        await syncNotificationAudience();
        await pruneSendLedger();
      }

      for (const campaign of getDueCampaigns(now)) {
        if (!isCampaignEnabled(campaign)) {
          continue;
        }

        await runCampaign(campaign.key, { source: "scheduler" });
      }
    } catch (error) {
      console.error("[Notifications] Scheduler tick failed", error);
    }
  }
}

export const notificationScheduler = new NotificationScheduler();

/**
 * Everything the admin panel needs in one round trip: how big the opted-in
 * audience is, what each campaign has been doing, and why sends are failing.
 */
export async function getNotificationAdminSummary() {
  const [audience, runs, campaigns, failures] = await Promise.all([
    dbQuery<{
      opted_in: string;
      known_wallets: string;
      opted_out: string;
      last_synced_at: string | null;
    }>(
      `
        SELECT
          COUNT(*) FILTER (WHERE notifications_enabled)::text     AS opted_in,
          COUNT(*)::text                                          AS known_wallets,
          COUNT(*) FILTER (WHERE NOT notifications_enabled)::text AS opted_out,
          MAX(last_synced_at)                                     AS last_synced_at
        FROM notification_audience
      `
    ),
    dbQuery(
      `
        SELECT id, campaign, source, dry_run, audience_size, targeted, capped,
               sent_count, failed_count, error, started_at, finished_at
        FROM notification_runs
        ORDER BY started_at DESC
        LIMIT 20
      `
    ),
    dbQuery(
      `
        SELECT campaign,
               COUNT(*) FILTER (WHERE status = 'sent')::int    AS sent,
               COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
               COUNT(*) FILTER (WHERE status = 'dry_run')::int AS dry_run,
               MAX(created_at)                                 AS last_sent_at
        FROM notification_sends
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY campaign
        ORDER BY sent DESC
      `
    ),
    dbQuery(
      `
        SELECT failure_reason, COUNT(*)::int AS count
        FROM notification_sends
        WHERE status = 'failed'
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY failure_reason
        ORDER BY count DESC
        LIMIT 10
      `
    ),
  ]);

  const audienceRow = audience.rows[0];

  return {
    configured: isBaseNotificationsConfigured(),
    enabled: notificationsEnabled(),
    dryRun: isDryRun(),
    maxPerRun: getMaxRecipientsPerRun(),
    audience: {
      optedIn: Number(audienceRow?.opted_in || 0),
      optedOut: Number(audienceRow?.opted_out || 0),
      knownWallets: Number(audienceRow?.known_wallets || 0),
      lastSyncedAt: audienceRow?.last_synced_at ?? null,
    },
    campaigns: CAMPAIGN_KEYS.map((key) => {
      const definition = CAMPAIGNS[key];
      const stats = campaigns.rows.find(
        (row) => (row as { campaign: string }).campaign === key
      );

      return {
        key,
        label: definition.label,
        description: definition.description,
        targetPath: definition.targetPath,
        runHourUtc: definition.runHourUtc,
        runDayOfWeekUtc: definition.runDayOfWeekUtc,
        enabled: isCampaignEnabled(definition),
        stats: stats ?? { sent: 0, failed: 0, dry_run: 0, last_sent_at: null },
      };
    }),
    recentRuns: runs.rows,
    failureReasons: failures.rows,
  };
}
