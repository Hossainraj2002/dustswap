import { dbQuery } from "../lib/db";

export type MonitorWindowKey = "utc-day" | "3d" | "7d" | "30d" | "90d";

type NumericLike = number | string | null | undefined;

type SummaryRow = {
  tracked_users: NumericLike;
  new_users: NumericLike;
  returning_users: NumericLike;
  registered_users: NumericLike;
  total_transactions: NumericLike;
  swap_transactions: NumericLike;
  sweep_transactions: NumericLike;
  checkin_transactions: NumericLike;
  spin_transactions: NumericLike;
  swapping_users: NumericLike;
  total_volume_usd: NumericLike;
  swap_volume_usd: NumericLike;
  sweep_volume_usd: NumericLike;
  checkin_payment_usd: NumericLike;
  check_ins: NumericLike;
  check_in_users: NumericLike;
  spins: NumericLike;
  spin_users: NumericLike;
};

type SeriesRow = {
  date_key: string;
  tracked_users: NumericLike;
  new_users: NumericLike;
  returning_users: NumericLike;
  transactions: NumericLike;
  swapping_users: NumericLike;
  volume_usd: NumericLike;
  check_ins: NumericLike;
  spins: NumericLike;
};

type SourceBreakdownRow = {
  source: string;
  transactions: NumericLike;
  users: NumericLike;
  volume_usd: NumericLike;
};

type UserActivityRow = {
  user_id: NumericLike;
  address: string | null;
  first_seen_at: string | null;
  last_activity_at: string | null;
  total_events: NumericLike;
  swap_transactions: NumericLike;
  sweep_transactions: NumericLike;
  check_ins: NumericLike;
  spins: NumericLike;
  volume_usd: NumericLike;
};

type TransactionRow = {
  kind: string;
  occurred_at: string | null;
  address: string | null;
  tx_hash: string | null;
  chain_id: NumericLike;
  amount_usd: NumericLike;
  status: string | null;
};

type CheckInRow = {
  occurred_at: string | null;
  address: string | null;
  check_in_date: string | null;
  points_earned: NumericLike;
  streak_day: NumericLike;
  payment_tx_hash: string | null;
  payment_amount_usd: NumericLike;
};

type SpinRow = {
  occurred_at: string | null;
  address: string | null;
  tx_hash: string | null;
  reward_label: string | null;
  reward_type: string | null;
  reward_amount: NumericLike;
  reward_points: NumericLike;
  ticket_cost: NumericLike;
  execution_type: string | null;
  status: string | null;
};

const WINDOW_DAYS: Record<MonitorWindowKey, number> = {
  "utc-day": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function toNumber(value: NumericLike) {
  if (value == null || value === "") {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeWindow(value?: string | null): MonitorWindowKey {
  return value && value in WINDOW_DAYS ? (value as MonitorWindowKey) : "utc-day";
}

function addUtcDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getUtcWindow(windowKey: MonitorWindowKey) {
  const days = WINDOW_DAYS[windowKey];
  const now = new Date();
  const currentUtcStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const end = addUtcDays(currentUtcStart, 1);
  const start = addUtcDays(end, -days);
  const previousStart = addUtcDays(start, -days);

  return {
    key: windowKey,
    days,
    start,
    end,
    previousStart,
  };
}

function normalizeSummary(row: SummaryRow) {
  return {
    trackedUsers: toNumber(row.tracked_users),
    newUsers: toNumber(row.new_users),
    returningUsers: toNumber(row.returning_users),
    registeredUsers: toNumber(row.registered_users),
    totalTransactions: toNumber(row.total_transactions),
    swapTransactions: toNumber(row.swap_transactions),
    sweepTransactions: toNumber(row.sweep_transactions),
    checkinTransactions: toNumber(row.checkin_transactions),
    spinTransactions: toNumber(row.spin_transactions),
    swappingUsers: toNumber(row.swapping_users),
    totalVolumeUsd: toNumber(row.total_volume_usd),
    swapVolumeUsd: toNumber(row.swap_volume_usd),
    sweepVolumeUsd: toNumber(row.sweep_volume_usd),
    checkinPaymentUsd: toNumber(row.checkin_payment_usd),
    checkIns: toNumber(row.check_ins),
    checkInUsers: toNumber(row.check_in_users),
    spins: toNumber(row.spins),
    spinUsers: toNumber(row.spin_users),
  };
}

async function loadSummary(start: Date, end: Date) {
  const result = await dbQuery<SummaryRow>(
    `
    WITH bounds AS (
      SELECT $1::timestamptz AS start_at, $2::timestamptz AS end_at
    ),
    swap_events AS (
      SELECT user_id, amount_usd::numeric AS amount_usd
      FROM swap_transactions, bounds
      WHERE occurred_at >= bounds.start_at
        AND occurred_at < bounds.end_at
    ),
    sweep_events AS (
      SELECT users.id AS user_id, COALESCE(sweeps.value_usd, 0)::numeric AS amount_usd
      FROM sweeps
      JOIN users ON lower(users.address) = lower(sweeps.user_address)
      CROSS JOIN bounds
      WHERE sweeps.created_at >= bounds.start_at
        AND sweeps.created_at < bounds.end_at
    ),
    checkin_events AS (
      SELECT user_id, COALESCE(payment_amount_usd, 0)::numeric AS amount_usd, payment_tx_hash
      FROM check_ins, bounds
      WHERE (created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (created_at AT TIME ZONE 'UTC') < bounds.end_at
    ),
    spin_events AS (
      SELECT user_id
      FROM spin_history, bounds
      WHERE (created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (created_at AT TIME ZONE 'UTC') < bounds.end_at
    ),
    active_users AS (
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM swap_events
        UNION ALL
        SELECT user_id FROM sweep_events
        UNION ALL
        SELECT user_id FROM checkin_events
        UNION ALL
        SELECT user_id FROM spin_events
      ) events
      WHERE user_id IS NOT NULL
    ),
    swapping_users AS (
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM swap_events
        UNION ALL
        SELECT user_id FROM sweep_events
      ) events
      WHERE user_id IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*)::bigint FROM active_users) AS tracked_users,
      (
        SELECT COUNT(*)::bigint
        FROM active_users
        JOIN users ON users.id = active_users.user_id
        CROSS JOIN bounds
        WHERE (users.created_at AT TIME ZONE 'UTC') >= bounds.start_at
          AND (users.created_at AT TIME ZONE 'UTC') < bounds.end_at
      ) AS new_users,
      (
        SELECT COUNT(*)::bigint
        FROM active_users
        JOIN users ON users.id = active_users.user_id
        CROSS JOIN bounds
        WHERE (users.created_at AT TIME ZONE 'UTC') < bounds.start_at
      ) AS returning_users,
      (
        SELECT COUNT(*)::bigint
        FROM users, bounds
        WHERE (users.created_at AT TIME ZONE 'UTC') >= bounds.start_at
          AND (users.created_at AT TIME ZONE 'UTC') < bounds.end_at
      ) AS registered_users,
      (
        (SELECT COUNT(*)::bigint FROM swap_events) +
        (SELECT COUNT(*)::bigint FROM sweep_events) +
        (SELECT COUNT(*)::bigint FROM checkin_events WHERE payment_tx_hash IS NOT NULL) +
        (SELECT COUNT(*)::bigint FROM spin_events)
      ) AS total_transactions,
      (SELECT COUNT(*)::bigint FROM swap_events) AS swap_transactions,
      (SELECT COUNT(*)::bigint FROM sweep_events) AS sweep_transactions,
      (SELECT COUNT(*)::bigint FROM checkin_events WHERE payment_tx_hash IS NOT NULL) AS checkin_transactions,
      (SELECT COUNT(*)::bigint FROM spin_events) AS spin_transactions,
      (SELECT COUNT(*)::bigint FROM swapping_users) AS swapping_users,
      (
        (SELECT COALESCE(SUM(amount_usd), 0) FROM swap_events) +
        (SELECT COALESCE(SUM(amount_usd), 0) FROM sweep_events) +
        (SELECT COALESCE(SUM(amount_usd), 0) FROM checkin_events)
      )::text AS total_volume_usd,
      (SELECT COALESCE(SUM(amount_usd), 0)::text FROM swap_events) AS swap_volume_usd,
      (SELECT COALESCE(SUM(amount_usd), 0)::text FROM sweep_events) AS sweep_volume_usd,
      (SELECT COALESCE(SUM(amount_usd), 0)::text FROM checkin_events) AS checkin_payment_usd,
      (SELECT COUNT(*)::bigint FROM checkin_events) AS check_ins,
      (SELECT COUNT(DISTINCT user_id)::bigint FROM checkin_events WHERE user_id IS NOT NULL) AS check_in_users,
      (SELECT COUNT(*)::bigint FROM spin_events) AS spins,
      (SELECT COUNT(DISTINCT user_id)::bigint FROM spin_events WHERE user_id IS NOT NULL) AS spin_users
    `,
    [start.toISOString(), end.toISOString()]
  );

  return normalizeSummary(result.rows[0]);
}

async function loadSeries(start: Date, end: Date) {
  const result = await dbQuery<SeriesRow>(
    `
    WITH bounds AS (
      SELECT $1::timestamptz AS start_at, $2::timestamptz AS end_at
    ),
    days AS (
      SELECT generate_series(
        (SELECT start_at::date FROM bounds),
        (SELECT (end_at - INTERVAL '1 second')::date FROM bounds),
        INTERVAL '1 day'
      )::date AS date_key
    ),
    events AS (
      SELECT
        (occurred_at AT TIME ZONE 'UTC')::date AS date_key,
        user_id,
        'swap'::text AS event_source,
        1::integer AS transaction_count,
        amount_usd::numeric AS volume_usd,
        0::integer AS check_in_count,
        0::integer AS spin_count
      FROM swap_transactions, bounds
      WHERE occurred_at >= bounds.start_at
        AND occurred_at < bounds.end_at

      UNION ALL

      SELECT
        (sweeps.created_at AT TIME ZONE 'UTC')::date AS date_key,
        users.id AS user_id,
        'sweep'::text AS event_source,
        1::integer AS transaction_count,
        COALESCE(sweeps.value_usd, 0)::numeric AS volume_usd,
        0::integer AS check_in_count,
        0::integer AS spin_count
      FROM sweeps
      JOIN users ON lower(users.address) = lower(sweeps.user_address)
      CROSS JOIN bounds
      WHERE sweeps.created_at >= bounds.start_at
        AND sweeps.created_at < bounds.end_at

      UNION ALL

      SELECT
        (created_at AT TIME ZONE 'UTC')::date AS date_key,
        user_id,
        'check_in'::text AS event_source,
        CASE WHEN payment_tx_hash IS NULL THEN 0 ELSE 1 END AS transaction_count,
        COALESCE(payment_amount_usd, 0)::numeric AS volume_usd,
        1::integer AS check_in_count,
        0::integer AS spin_count
      FROM check_ins, bounds
      WHERE (created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (created_at AT TIME ZONE 'UTC') < bounds.end_at

      UNION ALL

      SELECT
        (created_at AT TIME ZONE 'UTC')::date AS date_key,
        user_id,
        'spin'::text AS event_source,
        1::integer AS transaction_count,
        0::numeric AS volume_usd,
        0::integer AS check_in_count,
        1::integer AS spin_count
      FROM spin_history, bounds
      WHERE (created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (created_at AT TIME ZONE 'UTC') < bounds.end_at
    )
    SELECT
      to_char(days.date_key, 'YYYY-MM-DD') AS date_key,
      COUNT(DISTINCT events.user_id)::bigint AS tracked_users,
      COUNT(DISTINCT events.user_id) FILTER (
        WHERE users.id IS NOT NULL
          AND (users.created_at AT TIME ZONE 'UTC') >= days.date_key::timestamptz
          AND (users.created_at AT TIME ZONE 'UTC') < (days.date_key + 1)::timestamptz
      )::bigint AS new_users,
      COUNT(DISTINCT events.user_id) FILTER (
        WHERE users.id IS NOT NULL
          AND (users.created_at AT TIME ZONE 'UTC') < days.date_key::timestamptz
      )::bigint AS returning_users,
      COALESCE(SUM(events.transaction_count), 0)::bigint AS transactions,
      COUNT(DISTINCT events.user_id) FILTER (
        WHERE events.event_source IN ('swap', 'sweep')
      )::bigint AS swapping_users,
      COALESCE(SUM(events.volume_usd), 0)::text AS volume_usd,
      COALESCE(SUM(events.check_in_count), 0)::bigint AS check_ins,
      COALESCE(SUM(events.spin_count), 0)::bigint AS spins
    FROM days
    LEFT JOIN events ON events.date_key = days.date_key
    LEFT JOIN users ON users.id = events.user_id
    GROUP BY days.date_key
    ORDER BY days.date_key ASC
    `,
    [start.toISOString(), end.toISOString()]
  );

  return result.rows.map((row) => ({
    date: row.date_key,
    trackedUsers: toNumber(row.tracked_users),
    newUsers: toNumber(row.new_users),
    returningUsers: toNumber(row.returning_users),
    transactions: toNumber(row.transactions),
    swappingUsers: toNumber(row.swapping_users),
    volumeUsd: toNumber(row.volume_usd),
    checkIns: toNumber(row.check_ins),
    spins: toNumber(row.spins),
  }));
}

async function loadSourceBreakdown(start: Date, end: Date) {
  const result = await dbQuery<SourceBreakdownRow>(
    `
    WITH bounds AS (
      SELECT $1::timestamptz AS start_at, $2::timestamptz AS end_at
    ),
    sources AS (
      SELECT
        'Swap'::text AS source,
        user_id,
        1::integer AS transactions,
        amount_usd::numeric AS volume_usd
      FROM swap_transactions, bounds
      WHERE occurred_at >= bounds.start_at
        AND occurred_at < bounds.end_at

      UNION ALL

      SELECT
        'DustSweep'::text AS source,
        users.id AS user_id,
        1::integer AS transactions,
        COALESCE(sweeps.value_usd, 0)::numeric AS volume_usd
      FROM sweeps
      JOIN users ON lower(users.address) = lower(sweeps.user_address)
      CROSS JOIN bounds
      WHERE sweeps.created_at >= bounds.start_at
        AND sweeps.created_at < bounds.end_at

      UNION ALL

      SELECT
        'Check-in payment'::text AS source,
        user_id,
        CASE WHEN payment_tx_hash IS NULL THEN 0 ELSE 1 END AS transactions,
        COALESCE(payment_amount_usd, 0)::numeric AS volume_usd
      FROM check_ins, bounds
      WHERE (created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (created_at AT TIME ZONE 'UTC') < bounds.end_at

      UNION ALL

      SELECT
        'Spin'::text AS source,
        user_id,
        1::integer AS transactions,
        0::numeric AS volume_usd
      FROM spin_history, bounds
      WHERE (created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (created_at AT TIME ZONE 'UTC') < bounds.end_at
    )
    SELECT
      source,
      COALESCE(SUM(transactions), 0)::bigint AS transactions,
      COUNT(DISTINCT user_id)::bigint AS users,
      COALESCE(SUM(volume_usd), 0)::text AS volume_usd
    FROM sources
    GROUP BY source
    ORDER BY transactions DESC, source ASC
    `,
    [start.toISOString(), end.toISOString()]
  );

  return result.rows.map((row) => ({
    source: row.source,
    transactions: toNumber(row.transactions),
    users: toNumber(row.users),
    volumeUsd: toNumber(row.volume_usd),
  }));
}

async function loadUserActivity(start: Date, end: Date) {
  const result = await dbQuery<UserActivityRow>(
    `
    WITH bounds AS (
      SELECT $1::timestamptz AS start_at, $2::timestamptz AS end_at
    ),
    events AS (
      SELECT
        user_id,
        occurred_at AS occurred_at,
        1::integer AS swap_transactions,
        0::integer AS sweep_transactions,
        0::integer AS check_ins,
        0::integer AS spins,
        amount_usd::numeric AS volume_usd
      FROM swap_transactions, bounds
      WHERE occurred_at >= bounds.start_at
        AND occurred_at < bounds.end_at

      UNION ALL

      SELECT
        users.id AS user_id,
        sweeps.created_at AS occurred_at,
        0::integer AS swap_transactions,
        1::integer AS sweep_transactions,
        0::integer AS check_ins,
        0::integer AS spins,
        COALESCE(sweeps.value_usd, 0)::numeric AS volume_usd
      FROM sweeps
      JOIN users ON lower(users.address) = lower(sweeps.user_address)
      CROSS JOIN bounds
      WHERE sweeps.created_at >= bounds.start_at
        AND sweeps.created_at < bounds.end_at

      UNION ALL

      SELECT
        user_id,
        created_at AT TIME ZONE 'UTC' AS occurred_at,
        0::integer AS swap_transactions,
        0::integer AS sweep_transactions,
        1::integer AS check_ins,
        0::integer AS spins,
        COALESCE(payment_amount_usd, 0)::numeric AS volume_usd
      FROM check_ins, bounds
      WHERE (created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (created_at AT TIME ZONE 'UTC') < bounds.end_at

      UNION ALL

      SELECT
        user_id,
        created_at AT TIME ZONE 'UTC' AS occurred_at,
        0::integer AS swap_transactions,
        0::integer AS sweep_transactions,
        0::integer AS check_ins,
        1::integer AS spins,
        0::numeric AS volume_usd
      FROM spin_history, bounds
      WHERE (created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (created_at AT TIME ZONE 'UTC') < bounds.end_at
    )
    SELECT
      users.id AS user_id,
      users.address,
      users.created_at AT TIME ZONE 'UTC' AS first_seen_at,
      MAX(events.occurred_at) AS last_activity_at,
      COUNT(*)::bigint AS total_events,
      COALESCE(SUM(events.swap_transactions), 0)::bigint AS swap_transactions,
      COALESCE(SUM(events.sweep_transactions), 0)::bigint AS sweep_transactions,
      COALESCE(SUM(events.check_ins), 0)::bigint AS check_ins,
      COALESCE(SUM(events.spins), 0)::bigint AS spins,
      COALESCE(SUM(events.volume_usd), 0) AS volume_usd
    FROM events
    JOIN users ON users.id = events.user_id
    WHERE events.user_id IS NOT NULL
    GROUP BY users.id, users.address, users.created_at
    ORDER BY total_events DESC, volume_usd DESC, users.id ASC
    LIMIT 80
    `,
    [start.toISOString(), end.toISOString()]
  );

  return result.rows.map((row) => ({
    userId: toNumber(row.user_id),
    address: row.address,
    firstSeenAt: row.first_seen_at,
    lastActivityAt: row.last_activity_at,
    totalEvents: toNumber(row.total_events),
    swapTransactions: toNumber(row.swap_transactions),
    sweepTransactions: toNumber(row.sweep_transactions),
    checkIns: toNumber(row.check_ins),
    spins: toNumber(row.spins),
    volumeUsd: toNumber(row.volume_usd),
  }));
}

async function loadTransactions(start: Date, end: Date) {
  const result = await dbQuery<TransactionRow>(
    `
    WITH bounds AS (
      SELECT $1::timestamptz AS start_at, $2::timestamptz AS end_at
    ),
    transactions AS (
      SELECT
        'Swap'::text AS kind,
        occurred_at AS occurred_at,
        address::text AS address,
        tx_hash::text AS tx_hash,
        chain_id,
        amount_usd::numeric AS amount_usd,
        'recorded'::text AS status
      FROM swap_transactions, bounds
      WHERE occurred_at >= bounds.start_at
        AND occurred_at < bounds.end_at

      UNION ALL

      SELECT
        'DustSweep'::text AS kind,
        sweeps.created_at AS occurred_at,
        sweeps.user_address::text AS address,
        sweeps.tx_hash::text AS tx_hash,
        sweeps.chain_id,
        COALESCE(sweeps.value_usd, 0)::numeric AS amount_usd,
        'recorded'::text AS status
      FROM sweeps, bounds
      WHERE sweeps.created_at >= bounds.start_at
        AND sweeps.created_at < bounds.end_at
        AND sweeps.tx_hash IS NOT NULL

      UNION ALL

      SELECT
        'Check-in payment'::text AS kind,
        check_ins.created_at AT TIME ZONE 'UTC' AS occurred_at,
        users.address::text AS address,
        check_ins.payment_tx_hash::text AS tx_hash,
        NULL::integer AS chain_id,
        COALESCE(check_ins.payment_amount_usd, 0)::numeric AS amount_usd,
        COALESCE(check_ins.payment_asset, 'paid')::text AS status
      FROM check_ins
      LEFT JOIN users ON users.id = check_ins.user_id
      CROSS JOIN bounds
      WHERE (check_ins.created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (check_ins.created_at AT TIME ZONE 'UTC') < bounds.end_at
        AND check_ins.payment_tx_hash IS NOT NULL

      UNION ALL

      SELECT
        'Spin'::text AS kind,
        spin_history.created_at AT TIME ZONE 'UTC' AS occurred_at,
        users.address::text AS address,
        spin_history.tx_hash::text AS tx_hash,
        NULL::integer AS chain_id,
        0::numeric AS amount_usd,
        spin_history.status::text AS status
      FROM spin_history
      LEFT JOIN users ON users.id = spin_history.user_id
      CROSS JOIN bounds
      WHERE (spin_history.created_at AT TIME ZONE 'UTC') >= bounds.start_at
        AND (spin_history.created_at AT TIME ZONE 'UTC') < bounds.end_at
    )
    SELECT *
    FROM transactions
    ORDER BY occurred_at DESC
    LIMIT 100
    `,
    [start.toISOString(), end.toISOString()]
  );

  return result.rows.map((row) => ({
    kind: row.kind,
    occurredAt: row.occurred_at,
    address: row.address,
    txHash: row.tx_hash,
    chainId: row.chain_id == null ? null : toNumber(row.chain_id),
    amountUsd: toNumber(row.amount_usd),
    status: row.status,
  }));
}

async function loadCheckIns(start: Date, end: Date) {
  const result = await dbQuery<CheckInRow>(
    `
    WITH bounds AS (
      SELECT $1::timestamptz AS start_at, $2::timestamptz AS end_at
    )
    SELECT
      check_ins.created_at AT TIME ZONE 'UTC' AS occurred_at,
      users.address,
      check_ins.check_in_date::text AS check_in_date,
      check_ins.points_earned,
      check_ins.streak_day,
      check_ins.payment_tx_hash,
      COALESCE(check_ins.payment_amount_usd, 0)::text AS payment_amount_usd
    FROM check_ins
    LEFT JOIN users ON users.id = check_ins.user_id
    CROSS JOIN bounds
    WHERE (check_ins.created_at AT TIME ZONE 'UTC') >= bounds.start_at
      AND (check_ins.created_at AT TIME ZONE 'UTC') < bounds.end_at
    ORDER BY check_ins.created_at DESC
    LIMIT 100
    `,
    [start.toISOString(), end.toISOString()]
  );

  return result.rows.map((row) => ({
    occurredAt: row.occurred_at,
    address: row.address,
    checkInDate: row.check_in_date,
    pointsEarned: toNumber(row.points_earned),
    streakDay: toNumber(row.streak_day),
    paymentTxHash: row.payment_tx_hash,
    paymentAmountUsd: toNumber(row.payment_amount_usd),
  }));
}

async function loadSpins(start: Date, end: Date) {
  const result = await dbQuery<SpinRow>(
    `
    WITH bounds AS (
      SELECT $1::timestamptz AS start_at, $2::timestamptz AS end_at
    )
    SELECT
      spin_history.created_at AT TIME ZONE 'UTC' AS occurred_at,
      users.address,
      spin_history.tx_hash,
      spin_history.reward_label,
      spin_history.reward_type,
      COALESCE(spin_history.reward_amount, 0)::text AS reward_amount,
      spin_history.reward_points,
      spin_history.ticket_cost,
      spin_history.execution_type,
      spin_history.status
    FROM spin_history
    LEFT JOIN users ON users.id = spin_history.user_id
    CROSS JOIN bounds
    WHERE (spin_history.created_at AT TIME ZONE 'UTC') >= bounds.start_at
      AND (spin_history.created_at AT TIME ZONE 'UTC') < bounds.end_at
    ORDER BY spin_history.created_at DESC
    LIMIT 100
    `,
    [start.toISOString(), end.toISOString()]
  );

  return result.rows.map((row) => ({
    occurredAt: row.occurred_at,
    address: row.address,
    txHash: row.tx_hash,
    rewardLabel: row.reward_label,
    rewardType: row.reward_type,
    rewardAmount: toNumber(row.reward_amount),
    rewardPoints: toNumber(row.reward_points),
    ticketCost: toNumber(row.ticket_cost),
    executionType: row.execution_type,
    status: row.status,
  }));
}

export async function getAdminMonitor(windowValue?: string | null) {
  const windowKey = normalizeWindow(windowValue);
  const range = getUtcWindow(windowKey);

  const [
    current,
    previous,
    series,
    sourceBreakdown,
    userActivity,
    transactions,
    checkIns,
    spins,
  ] = await Promise.all([
    loadSummary(range.start, range.end),
    loadSummary(range.previousStart, range.start),
    loadSeries(range.start, range.end),
    loadSourceBreakdown(range.start, range.end),
    loadUserActivity(range.start, range.end),
    loadTransactions(range.start, range.end),
    loadCheckIns(range.start, range.end),
    loadSpins(range.start, range.end),
  ]);

  return {
    window: {
      key: range.key,
      days: range.days,
      startAt: range.start.toISOString(),
      endAt: range.end.toISOString(),
      previousStartAt: range.previousStart.toISOString(),
      timezone: "UTC",
    },
    current,
    previous,
    series,
    details: {
      sourceBreakdown,
      userActivity,
      transactions,
      checkIns,
      spins,
    },
    generatedAt: new Date().toISOString(),
  };
}
