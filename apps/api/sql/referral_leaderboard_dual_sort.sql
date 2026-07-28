-- Referral leaderboard dual-sort support.
-- Adds a second ranking (by referral COUNT) alongside the existing PP ranking so
-- the Referrals board can be sorted by "# of referrals" (default) or "PP".
--
-- Safe to run on a live database: purely additive (new column + new function
-- signatures with a defaulted p_sort argument) and idempotent. Run this in the
-- Supabase SQL editor BEFORE deploying the API/web that pass ?sort=count.

-- 1. Add the count-ordered rank column to the snapshot (nullable; the refresh
--    below repopulates every row).
ALTER TABLE referral_leaderboard_snapshot_entries
  ADD COLUMN IF NOT EXISTS count_rank BIGINT;

CREATE INDEX IF NOT EXISTS idx_referral_leaderboard_snapshot_entries_count_rank
  ON referral_leaderboard_snapshot_entries(count_rank);

-- 2. Live page ranking, now sort-aware.
--    p_sort = 'count' ranks by referred_users first; anything else keeps the
--    legacy PP-first ordering. Default 'pp' keeps old callers working.
--    Drop the previous 2-arg overload so PostgREST resolves a single candidate.
DROP FUNCTION IF EXISTS get_referral_leaderboard_page(INTEGER, INTEGER);
CREATE OR REPLACE FUNCTION get_referral_leaderboard_page(
  p_offset INTEGER,
  p_limit INTEGER,
  p_sort TEXT DEFAULT 'pp'
)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  address VARCHAR(42),
  total_points BIGINT,
  referral_points BIGINT,
  referred_users BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH referral_counts AS (
    SELECT referrer_id AS user_id, COUNT(*)::BIGINT AS referred_users
    FROM referrals
    WHERE referrer_id IS NOT NULL
    GROUP BY referrer_id
  ),
  referral_points AS (
    SELECT user_id, COALESCE(SUM(total_awarded), 0)::BIGINT AS referral_points
    FROM point_events
    WHERE action IN ('referral_commission', 'referral_new_user')
    GROUP BY user_id
  ),
  eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points,
      referral_counts.referred_users
    FROM users u
    JOIN referral_counts ON referral_counts.user_id = u.id
    WHERE referral_counts.referred_users > 0
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN p_sort = 'count' THEN eligible_users.referred_users END DESC,
          CASE WHEN p_sort = 'count' THEN COALESCE(referral_points.referral_points, 0) END DESC,
          CASE WHEN p_sort <> 'count' THEN COALESCE(referral_points.referral_points, 0) END DESC,
          CASE WHEN p_sort <> 'count' THEN eligible_users.referred_users END DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      COALESCE(referral_points.referral_points, 0)::BIGINT AS referral_points,
      eligible_users.referred_users::BIGINT AS referred_users
    FROM eligible_users
    LEFT JOIN referral_points ON referral_points.user_id = eligible_users.id
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.referral_points,
    ranked.referred_users
  FROM ranked
  ORDER BY ranked.rank
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

-- 3. Live viewer ranking, now sort-aware.
DROP FUNCTION IF EXISTS get_referral_leaderboard_viewer(INTEGER);
CREATE OR REPLACE FUNCTION get_referral_leaderboard_viewer(
  p_user_id INTEGER,
  p_sort TEXT DEFAULT 'pp'
)
RETURNS TABLE (
  rank BIGINT,
  user_id INTEGER,
  address VARCHAR(42),
  total_points BIGINT,
  referral_points BIGINT,
  referred_users BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH referral_counts AS (
    SELECT referrer_id AS user_id, COUNT(*)::BIGINT AS referred_users
    FROM referrals
    WHERE referrer_id IS NOT NULL
    GROUP BY referrer_id
  ),
  referral_points AS (
    SELECT user_id, COALESCE(SUM(total_awarded), 0)::BIGINT AS referral_points
    FROM point_events
    WHERE action IN ('referral_commission', 'referral_new_user')
    GROUP BY user_id
  ),
  eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points,
      referral_counts.referred_users
    FROM users u
    JOIN referral_counts ON referral_counts.user_id = u.id
    WHERE referral_counts.referred_users > 0
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN p_sort = 'count' THEN eligible_users.referred_users END DESC,
          CASE WHEN p_sort = 'count' THEN COALESCE(referral_points.referral_points, 0) END DESC,
          CASE WHEN p_sort <> 'count' THEN COALESCE(referral_points.referral_points, 0) END DESC,
          CASE WHEN p_sort <> 'count' THEN eligible_users.referred_users END DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      COALESCE(referral_points.referral_points, 0)::BIGINT AS referral_points,
      eligible_users.referred_users::BIGINT AS referred_users
    FROM eligible_users
    LEFT JOIN referral_points ON referral_points.user_id = eligible_users.id
  )
  SELECT
    ranked.rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.referral_points,
    ranked.referred_users
  FROM ranked
  WHERE ranked.user_id = p_user_id
  LIMIT 1;
$$;

-- 4. Snapshot refresh now stores BOTH ranks per user.
CREATE OR REPLACE FUNCTION refresh_referral_leaderboard_snapshot()
RETURNS TABLE (
  refreshed_at TIMESTAMPTZ,
  total_entries BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_refreshed_at TIMESTAMPTZ := timezone('utc', now());
  v_total_entries BIGINT := 0;
BEGIN
  CREATE TEMP TABLE tmp_referral_leaderboard_snapshot ON COMMIT DROP AS
  WITH referral_counts AS (
    SELECT referrer_id AS user_id, COUNT(*)::BIGINT AS referred_users
    FROM referrals
    WHERE referrer_id IS NOT NULL
    GROUP BY referrer_id
  ),
  referral_points AS (
    SELECT user_id, COALESCE(SUM(total_awarded), 0)::BIGINT AS referral_points
    FROM point_events
    WHERE action IN ('referral_commission', 'referral_new_user')
    GROUP BY user_id
  ),
  eligible_users AS (
    SELECT
      u.id,
      u.address,
      u.total_points,
      referral_counts.referred_users
    FROM users u
    JOIN referral_counts ON referral_counts.user_id = u.id
    WHERE referral_counts.referred_users > 0
  ),
  ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY
          COALESCE(referral_points.referral_points, 0) DESC,
          eligible_users.referred_users DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS rank,
      ROW_NUMBER() OVER (
        ORDER BY
          eligible_users.referred_users DESC,
          COALESCE(referral_points.referral_points, 0) DESC,
          eligible_users.total_points DESC,
          eligible_users.id ASC
      )::BIGINT AS count_rank,
      eligible_users.id AS user_id,
      eligible_users.address,
      eligible_users.total_points::BIGINT AS total_points,
      COALESCE(referral_points.referral_points, 0)::BIGINT AS referral_points,
      eligible_users.referred_users::BIGINT AS referred_users
    FROM eligible_users
    LEFT JOIN referral_points ON referral_points.user_id = eligible_users.id
  )
  SELECT
    ranked.rank,
    ranked.count_rank,
    ranked.user_id,
    ranked.address,
    ranked.total_points,
    ranked.referral_points,
    ranked.referred_users,
    v_refreshed_at AS refreshed_at
  FROM ranked;

  SELECT COUNT(*)::BIGINT INTO v_total_entries
  FROM tmp_referral_leaderboard_snapshot;

  TRUNCATE TABLE referral_leaderboard_snapshot_entries;

  INSERT INTO referral_leaderboard_snapshot_entries (
    rank,
    count_rank,
    user_id,
    address,
    total_points,
    referral_points,
    referred_users,
    refreshed_at
  )
  SELECT
    snapshot.rank,
    snapshot.count_rank,
    snapshot.user_id,
    snapshot.address,
    snapshot.total_points,
    snapshot.referral_points,
    snapshot.referred_users,
    snapshot.refreshed_at
  FROM tmp_referral_leaderboard_snapshot AS snapshot
  ORDER BY rank;

  INSERT INTO referral_leaderboard_snapshot_meta (
    singleton,
    refreshed_at,
    total_entries
  )
  VALUES (1, v_refreshed_at, v_total_entries)
  ON CONFLICT (singleton) DO UPDATE
  SET
    refreshed_at = EXCLUDED.refreshed_at,
    total_entries = EXCLUDED.total_entries;

  RETURN QUERY
  SELECT v_refreshed_at, v_total_entries;
END;
$$;

-- 5. Populate count_rank immediately so the count board is correct right away.
SELECT refresh_referral_leaderboard_snapshot();
