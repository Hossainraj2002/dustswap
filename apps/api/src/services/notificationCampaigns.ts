/**
 * Campaign definitions for Base App notifications.
 *
 * Each campaign is a segment query plus a copy template. Segments resolve
 * through user_wallets rather than users.address, because users.address becomes
 * 'merged:<id>' after an account merge and would never match an audience row.
 *
 * Two invariants every campaign relies on:
 *
 * 1. One notification per merged account, not per wallet. A user with a linked
 *    EOA and Base Account must not receive the same message twice, so segments
 *    pick a single wallet per users.id (primary first, then oldest link).
 *
 * 2. Copy must vary between runs. Base deduplicates identical notifications
 *    (same app_url + wallet + title + message + target_path) inside a 24h
 *    window and still returns success, so a fixed daily reminder would report
 *    delivery while reaching nobody. Recurring campaigns either interpolate a
 *    changing number or rotate through phrasings.
 */

import { dbQuery } from "../lib/db";
import { CFG } from "./pointsEngine";
import {
  MESSAGE_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "./baseNotifications";

export type CampaignKey =
  | "daily_check_in"
  | "streak_at_risk"
  | "streak_broken"
  | "unspent_tickets"
  | "dust_detected";

export type CampaignRow = {
  user_id: number;
  wallet: string;
  current_streak: number;
  spin_tickets: number;
  dust_usd: number;
  dust_tokens: number;
};

export type RenderedCopy = {
  title: string;
  message: string;
};

export type CampaignDefinition = {
  key: CampaignKey;
  label: string;
  description: string;
  targetPath: string;
  /** UTC hour the scheduler fires this campaign. */
  runHourUtc: number;
  /** 0 = Sunday. Null means every day. */
  runDayOfWeekUtc: number | null;
  /**
   * Minimum hours between two sends of THIS campaign to the same account. The
   * global cooldown stops campaigns stacking; this stops one campaign
   * repeating against a population that permanently matches it.
   */
  cooldownHours: number;
  enabledByDefault: boolean;
  envFlag: string;
  segment: (cooldownHours: number) => Promise<CampaignRow[]>;
  render: (row: CampaignRow, now: Date) => RenderedCopy;
};

const DEFAULT_GLOBAL_COOLDOWN_HOURS = 24;

/**
 * Bounds for the dust campaign.
 *
 * These are a correctness guard, not a preference. Token prices in the
 * discovery cache come from thin and sometimes faked pairs: the live cache
 * holds single "swappable" tokens valued at $4.1bn on a HIGH confidence price
 * and 1.3e42 on a MEDIUM one. priceConfidence alone does not filter them out.
 *
 * Without a ceiling this campaign would tell a real user they are holding
 * $686,470 of dust, which is both false and indistinguishable from a scam
 * notification. Anything above the per-token cap is not dust by definition, so
 * excluding it costs nothing and removes the entire class of bad copy.
 */
const DUST_DEFAULTS = {
  /** Minimum account total worth interrupting someone over. */
  MIN_TOTAL_USD: 10,
  /** Above this an account is not holding dust, it is holding a position. */
  MAX_TOTAL_USD: 1000,
  /** A single token worth more than this is not dust. */
  MAX_TOKEN_USD: 100,
  /**
   * Per-token floor, mirroring the Base sweep config's own minValueUsd
   * (DUST_SWEEP_MIN_VALUE_USD, default 0.01). Counting tokens the sweep engine
   * would skip makes the promised token count larger than the screen shows.
   */
  MIN_TOKEN_USD: 0.01,
};

function dustBound(envVar: string, fallback: number) {
  const value = Number(process.env[envVar]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getGlobalCooldownHours() {
  const value = Number(
    process.env.NOTIFICATIONS_GLOBAL_COOLDOWN_HOURS ?? DEFAULT_GLOBAL_COOLDOWN_HOURS
  );

  if (!Number.isFinite(value) || value < 1 || value > 336) {
    return DEFAULT_GLOBAL_COOLDOWN_HOURS;
  }

  return Math.floor(value);
}

/**
 * Shared prefix for every segment query.
 *
 * Fixed parameters, identical for every campaign:
 *   $1 global cooldown hours
 *   $2 discovery mode (boolean)
 *   $3 max consecutive failures before a wallet stops being probed
 *   $4 campaign key
 *   $5 per-campaign cooldown hours
 * Campaign-specific parameters start at $6.
 *
 * `audience` has two modes. In steady state it is only wallets Base has
 * confirmed opted in. In discovery mode it is the whole user base minus
 * wallets already proven unreachable, because Base's send response is the only
 * reliable way to learn who is a Base App user: sending to a non-member
 * delivers nothing and simply returns a failure reason.
 *
 * `resolved` collapses that down to one row per merged account, so a linked
 * EOA and Base Account pair cannot be notified twice.
 *
 * `eligible` applies two caps. The global one stops five campaigns stacking on
 * one person in a day. The per-campaign one stops a single campaign repeating
 * daily against a population that permanently matches it.
 */
const SEGMENT_PREFIX = `
WITH audience AS (
  SELECT w.wallet_address AS wallet
  FROM user_wallets w
  LEFT JOIN notification_audience na ON na.wallet_address = w.wallet_address
  WHERE CASE
    WHEN $2::boolean
      THEN COALESCE(na.consecutive_failures, 0) < $3::int
      ELSE na.notifications_enabled = TRUE AND na.state = 'confirmed'
  END
),
resolved AS (
  SELECT DISTINCT ON (u.id)
    u.id                             AS user_id,
    a.wallet                         AS wallet,
    COALESCE(u.current_streak, 0)    AS current_streak,
    COALESCE(u.spin_tickets, 0)      AS spin_tickets,
    u.last_check_in                  AS last_check_in
  FROM audience a
  JOIN user_wallets w ON w.wallet_address = a.wallet
  JOIN users u        ON u.id = w.user_id
  LEFT JOIN notification_audience pick ON pick.wallet_address = a.wallet
  -- A confirmed wallet wins over the primary one. After a merge the Base App
  -- wallet is often the linked secondary, and ordering by is_primary alone
  -- would keep addressing an EOA that can never receive a notification while
  -- ignoring the wallet Base has already confirmed for the same account.
  ORDER BY u.id,
           (pick.state = 'confirmed') DESC NULLS LAST,
           w.is_primary DESC,
           w.linked_at ASC
),
eligible AS (
  -- is_confirmed drives dispatch order. NOTIFICATIONS_MAX_PER_RUN truncates
  -- the result set, so without an ordering the cap would spend the whole
  -- budget on an arbitrary slice of mostly-unreachable wallets. Known Base App
  -- users always go first; discovery probing only spends what is left over.
  SELECT r.*,
         COALESCE(na.state = 'confirmed', FALSE) AS is_confirmed
  FROM resolved r
  LEFT JOIN notification_audience na ON na.wallet_address = r.wallet
  WHERE NOT EXISTS (
    SELECT 1
    FROM notification_sends s
    WHERE s.user_id = r.user_id
      AND s.status = 'sent'
      AND s.created_at > NOW() - ($1::int * INTERVAL '1 hour')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM notification_sends s
    WHERE s.user_id = r.user_id
      AND s.status = 'sent'
      AND s.campaign = $4::text
      AND s.created_at > NOW() - ($5::int * INTERVAL '1 hour')
  )
),
utc_day AS (
  SELECT date_trunc('day', (NOW() AT TIME ZONE 'utc')) AS day_start
)
`;

type RawSegmentRow = {
  user_id: number | string;
  wallet: string;
  current_streak: number | string | null;
  spin_tickets: number | string | null;
  dust_usd?: number | string | null;
  dust_tokens?: number | string | null;
};

function toCampaignRows(rows: RawSegmentRow[]): CampaignRow[] {
  return rows.map((row) => ({
    user_id: Number(row.user_id),
    wallet: String(row.wallet),
    current_streak: Number(row.current_streak || 0),
    spin_tickets: Number(row.spin_tickets || 0),
    dust_usd: Number(row.dust_usd || 0),
    dust_tokens: Number(row.dust_tokens || 0),
  }));
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 6;

/**
 * Discovery mode probes the whole user base so the audience can grow from send
 * results. Turn it off once the confirmed list is large enough that probing
 * costs more requests than it earns.
 */
export function isDiscoveryMode() {
  return isEnabled(process.env.NOTIFICATIONS_DISCOVERY_MODE, true);
}

function getMaxConsecutiveFailures() {
  const value = Number(
    process.env.NOTIFICATIONS_MAX_CONSECUTIVE_FAILURES ??
      DEFAULT_MAX_CONSECUTIVE_FAILURES
  );

  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_CONSECUTIVE_FAILURES;
  }

  return Math.floor(value);
}

async function runSegment(
  campaign: CampaignKey,
  cooldownHours: number,
  sql: string,
  extraParams: unknown[] = []
) {
  const { rows } = await dbQuery<RawSegmentRow>(SEGMENT_PREFIX + sql, [
    getGlobalCooldownHours(),
    isDiscoveryMode(),
    getMaxConsecutiveFailures(),
    campaign,
    cooldownHours,
    ...extraParams,
  ]);

  return toCampaignRows(rows);
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

/**
 * Guards against a dynamic value pushing copy past the API caps mid-run. A
 * three-digit streak or a large dust figure should degrade to a shorter line,
 * never abort the whole campaign with a 400.
 */
function fit(value: string, fallback: string, max: number) {
  if (value.length <= max) {
    return value;
  }

  return fallback.length <= max ? fallback : fallback.slice(0, max).trim();
}

function clampCopy(copy: RenderedCopy, fallback: RenderedCopy): RenderedCopy {
  return {
    title: fit(copy.title, fallback.title, TITLE_MAX_LENGTH),
    message: fit(copy.message, fallback.message, MESSAGE_MAX_LENGTH),
  };
}

function utcDayOfYear(now: Date) {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const diff = now.getTime() - start;
  return Math.floor(diff / 86_400_000);
}

/**
 * Four phrasings for the one campaign whose copy carries no naturally varying
 * number. Rotating by UTC day keeps consecutive sends distinct so Base does not
 * dedupe them away.
 */
const CHECK_IN_VARIANTS: RenderedCopy[] = [
  {
    title: `${CFG.SPIN_TICKETS_PER_CHECK_IN} spin tickets are waiting`,
    message: `Check in today on DustSwap to claim ${CFG.SPIN_TICKETS_PER_CHECK_IN} free spin tickets and ${CFG.CHECK_IN} points. One tap, no fee.`,
  },
  {
    title: `Free check-in, ${CFG.SPIN_TICKETS_PER_CHECK_IN} tickets`,
    message: `Your daily check-in on DustSwap is open. Claim ${CFG.CHECK_IN} points and ${CFG.SPIN_TICKETS_PER_CHECK_IN} spin tickets before midnight UTC.`,
  },
  {
    title: "Start a streak today",
    message: `Check in on DustSwap to start a points streak. Day one gives you ${CFG.CHECK_IN} points and ${CFG.SPIN_TICKETS_PER_CHECK_IN} spin tickets.`,
  },
  {
    title: `Claim your ${CFG.CHECK_IN} points today`,
    message: `Checking in on DustSwap is free and takes one tap. Today it is worth ${CFG.CHECK_IN} points and ${CFG.SPIN_TICKETS_PER_CHECK_IN} spin tickets.`,
  },
];

export const CAMPAIGNS: Record<CampaignKey, CampaignDefinition> = {
  /**
   * The core ask. Deliberately excludes anyone with a live streak, because
   * those users get the sharper streak_at_risk message instead.
   */
  daily_check_in: {
    key: "daily_check_in",
    label: "Daily check-in",
    description:
      "Opted-in users with no live streak who have not checked in today.",
    targetPath: "/profile",
    runHourUtc: 17,
    runDayOfWeekUtc: null,
    // Three days. This targets users with no streak and no check-in today,
    // which a dormant account matches every single day forever. At 24h it
    // would ping them daily until they mute the app, and opt-outs are final.
    cooldownHours: 72,
    enabledByDefault: true,
    envFlag: "NOTIFICATIONS_CAMPAIGN_DAILY_CHECK_IN_ENABLED",
    segment: (cooldownHours) =>
      runSegment(
        "daily_check_in",
        cooldownHours,
        `
        SELECT e.user_id, e.wallet, e.current_streak, e.spin_tickets,
               0::numeric AS dust_usd, 0::int AS dust_tokens
        FROM eligible e, utc_day d
        WHERE e.current_streak = 0
          AND (e.last_check_in IS NULL OR e.last_check_in < d.day_start)
        ORDER BY e.is_confirmed DESC, e.last_check_in DESC NULLS LAST
      `
      ),
    render: (_row, now) => {
      const variant =
        CHECK_IN_VARIANTS[utcDayOfYear(now) % CHECK_IN_VARIANTS.length];
      return clampCopy(variant, CHECK_IN_VARIANTS[2]);
    },
  },

  /**
   * Highest-value message in the set: the only one a user would be annoyed to
   * have missed. Copy varies naturally via the streak day.
   */
  streak_at_risk: {
    key: "streak_at_risk",
    label: "Streak at risk",
    description:
      "Opted-in users with a live streak who have not checked in yet today.",
    targetPath: "/profile",
    runHourUtc: 21,
    runDayOfWeekUtc: null,
    // Safe to fire daily: the segment below only matches someone whose streak
    // is genuinely alive and expiring tonight.
    cooldownHours: 20,
    enabledByDefault: true,
    envFlag: "NOTIFICATIONS_CAMPAIGN_STREAK_AT_RISK_ENABLED",
    segment: (cooldownHours) =>
      runSegment(
        "streak_at_risk",
        cooldownHours,
        `
        SELECT e.user_id, e.wallet, e.current_streak, e.spin_tickets,
               0::numeric AS dust_usd, 0::int AS dust_tokens
        FROM eligible e, utc_day d
        WHERE e.current_streak > 0
          AND e.last_check_in IS NOT NULL
          AND e.last_check_in <  d.day_start
          -- The streak is only truly at risk if they checked in yesterday.
          -- current_streak is not reset when a day is missed, so without this
          -- a user who lapsed months ago would match every night forever.
          AND e.last_check_in >= d.day_start - INTERVAL '1 day'
        ORDER BY e.is_confirmed DESC, e.current_streak DESC
      `
      ),
    render: (row) => {
      const boost = getBoostPercent(row.current_streak);
      const boostClause = boost > 0 ? ` to keep your ${boost}% points boost` : "";

      return clampCopy(
        {
          title: `Day ${row.current_streak} streak ends tonight`,
          message: `Your check-in streak resets at midnight UTC. Check in now${boostClause}.`,
        },
        {
          title: "Your streak ends tonight",
          message:
            "Your check-in streak resets at midnight UTC. Check in now to keep your points boost.",
        }
      );
    },
  },

  /**
   * Fires the day after a streak lapses, and only for that one day. Gated on
   * STREAK_RECOVERY_ENABLED because the restore flow it points at is itself
   * flag-gated in the points engine.
   */
  streak_broken: {
    key: "streak_broken",
    label: "Streak broken",
    description:
      "Users whose streak of 3 or more lapsed yesterday, messaged once.",
    targetPath: "/profile",
    runHourUtc: 12,
    runDayOfWeekUtc: null,
    cooldownHours: 168,
    enabledByDefault: false,
    envFlag: "NOTIFICATIONS_CAMPAIGN_STREAK_BROKEN_ENABLED",
    segment: (cooldownHours) =>
      runSegment(
        "streak_broken",
        cooldownHours,
        `
        SELECT e.user_id, e.wallet, e.current_streak, e.spin_tickets,
               0::numeric AS dust_usd, 0::int AS dust_tokens
        FROM eligible e, utc_day d
        WHERE e.current_streak >= 3
          AND e.last_check_in IS NOT NULL
          AND e.last_check_in <  d.day_start - INTERVAL '1 day'
          AND e.last_check_in >= d.day_start - INTERVAL '2 days'
        ORDER BY e.is_confirmed DESC, e.current_streak DESC
      `
      ),
    render: (row) =>
      clampCopy(
        {
          title: `Your ${row.current_streak} day streak broke`,
          message: `You missed yesterday. Restore your streak for $${CFG.STREAK_RESTORE_FEE_USD} to keep your points boost, or start again from day 1.`,
        },
        {
          title: "Your streak broke",
          message:
            "You missed yesterday. Restore your streak to keep your points boost, or start again from day 1.",
        }
      ),
  },

  /**
   * Weekly nudge for tickets sitting unspent. Ticket count varies the copy.
   */
  unspent_tickets: {
    key: "unspent_tickets",
    label: "Unspent spin tickets",
    description:
      "Users holding 3 or more spin tickets who have not spun in 7 days.",
    targetPath: "/spin",
    runHourUtc: 16,
    runDayOfWeekUtc: 0,
    cooldownHours: 168,
    enabledByDefault: true,
    envFlag: "NOTIFICATIONS_CAMPAIGN_UNSPENT_TICKETS_ENABLED",
    segment: (cooldownHours) =>
      runSegment(
        "unspent_tickets",
        cooldownHours,
        `
        SELECT e.user_id, e.wallet, e.current_streak, e.spin_tickets,
               0::numeric AS dust_usd, 0::int AS dust_tokens
        FROM eligible e
        WHERE e.spin_tickets >= 3
          AND NOT EXISTS (
            SELECT 1
            FROM spin_history sh
            WHERE sh.user_id = e.user_id
              AND sh.created_at > (NOW() AT TIME ZONE 'utc') - INTERVAL '7 days'
          )
        ORDER BY e.is_confirmed DESC, e.spin_tickets DESC
      `
      ),
    render: (row) =>
      clampCopy(
        {
          title: `You have ${row.spin_tickets} unused tickets`,
          message:
            "Your spin tickets are still unspent. Each one is a shot at bonus points. Open the wheel and use them.",
        },
        {
          title: "Unused spin tickets",
          message:
            "Your spin tickets are still unspent. Each one is a shot at bonus points. Open the wheel and use them.",
        }
      ),
  },

  /**
   * The one campaign no other app can send. Dust is aggregated across every
   * wallet on the merged account, then delivered to the account's primary
   * wallet.
   *
   * Only reaches wallets that have opened DustSweep in the last 7 days, since
   * the discovery cache is populated on scan rather than on a crawl.
   */
  dust_detected: {
    key: "dust_detected",
    label: "Dust detected",
    description:
      "Accounts holding at least $10 of discovered Base dust with no sweep in 14 days.",
    targetPath: "/dustsweep",
    runHourUtc: 15,
    runDayOfWeekUtc: 4,
    cooldownHours: 168,
    enabledByDefault: false,
    envFlag: "NOTIFICATIONS_CAMPAIGN_DUST_DETECTED_ENABLED",
    segment: (cooldownHours) =>
      runSegment(
        "dust_detected",
        cooldownHours,
        `
        , dust AS (
          -- Reads the live DustSweep discovery cache. wallet_token_balances is
          -- never populated in production, so it cannot back this campaign.
          --
          -- dustsweep_token_cache.address is the bare lowercase wallet for Base
          -- and '<chainId>:<wallet>' for every other chain, so an equality join
          -- on wallet_address is already a Base-only filter.
          --
          -- payload->'swappable' is the clean list; the discovery step keeps
          -- suspicious tokens in a separate 'suspicious' array, so nothing here
          -- can advertise a scam token back to the user.
          --
          -- $8 caps a single token's value. See DUST_DEFAULTS: mispriced pairs
          -- put multi-billion-dollar valuations on HIGH confidence tokens, and
          -- without this the copy would quote them back to real users.
          --
          -- $9 is the per-token floor. It mirrors the sweep engine's own
          -- minValueUsd for Base, so a token this campaign counts is a token
          -- DustSweep would actually include in a sweep. Without it the copy
          -- could promise "9 dust tokens" and then show the user a screen with
          -- three, because the rest were below the sweep threshold.
          SELECT w.user_id,
                 SUM((tok->>'valueUSD')::numeric) AS dust_usd,
                 COUNT(*)                         AS dust_tokens
          FROM user_wallets w
          JOIN dustsweep_token_cache t ON t.address = w.wallet_address
          CROSS JOIN LATERAL jsonb_array_elements(t.payload->'swappable') AS tok
          WHERE t.updated_at > NOW() - INTERVAL '7 days'
            AND jsonb_typeof(t.payload->'swappable') = 'array'
            AND tok->>'priceConfidence' = 'HIGH'
            AND tok->>'valueUSD' ~ '^[0-9]+(\\.[0-9]+)?$'
            AND (tok->>'valueUSD')::numeric >= $9::numeric
            AND (tok->>'valueUSD')::numeric <= $8::numeric
          GROUP BY w.user_id
        )
        SELECT e.user_id, e.wallet, e.current_streak, e.spin_tickets,
               d.dust_usd, d.dust_tokens
        FROM eligible e
        JOIN dust d ON d.user_id = e.user_id
        WHERE d.dust_usd >= $6::numeric
          AND d.dust_usd <= $7::numeric
          AND d.dust_tokens >= 2
          AND NOT EXISTS (
            SELECT 1
            FROM user_wallets uw
            JOIN sweeps s ON lower(s.user_address) = uw.wallet_address
            WHERE uw.user_id = e.user_id
              AND s.created_at > NOW() - INTERVAL '14 days'
          )
        ORDER BY e.is_confirmed DESC, d.dust_usd DESC
      `,
        [
          dustBound("NOTIFICATIONS_DUST_MIN_USD", DUST_DEFAULTS.MIN_TOTAL_USD),
          dustBound("NOTIFICATIONS_DUST_MAX_USD", DUST_DEFAULTS.MAX_TOTAL_USD),
          dustBound(
            "NOTIFICATIONS_DUST_MAX_TOKEN_USD",
            DUST_DEFAULTS.MAX_TOKEN_USD
          ),
          dustBound(
            "NOTIFICATIONS_DUST_MIN_TOKEN_USD",
            DUST_DEFAULTS.MIN_TOKEN_USD
          ),
        ]
      ),
    render: (row) =>
      clampCopy(
        {
          title: `You have $${Math.floor(row.dust_usd)} in dust`,
          message: `We found ${row.dust_tokens} dust tokens sitting in your wallet on Base. Sweep them into ETH in one transaction.`,
        },
        {
          title: "Dust found in your wallet",
          message:
            "We found dust tokens sitting in your wallet on Base. Sweep them into ETH in one transaction.",
        }
      ),
  },
};

export const CAMPAIGN_KEYS = Object.keys(CAMPAIGNS) as CampaignKey[];

export function isCampaignKey(value: string): value is CampaignKey {
  return CAMPAIGN_KEYS.includes(value as CampaignKey);
}

function isEnabled(value: string | undefined, fallback: boolean) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function isCampaignEnabled(campaign: CampaignDefinition) {
  if (!isEnabled(process.env[campaign.envFlag], campaign.enabledByDefault)) {
    return false;
  }

  // The restore flow this campaign points at is itself flag-gated, so pointing
  // users at a disabled feature would be worse than staying quiet.
  if (
    campaign.key === "streak_broken" &&
    !isEnabled(process.env.STREAK_RECOVERY_ENABLED, false)
  ) {
    return false;
  }

  return true;
}

export { getGlobalCooldownHours };
