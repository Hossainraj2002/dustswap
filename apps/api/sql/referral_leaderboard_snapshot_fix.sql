-- Fix ambiguous refreshed_at reference in referral snapshot refresh.
-- Run this in the Supabase SQL editor to restore the referral leaderboard.

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
    ranked.referred_users,
    v_refreshed_at AS refreshed_at
  FROM ranked;

  SELECT COUNT(*)::BIGINT INTO v_total_entries
  FROM tmp_referral_leaderboard_snapshot;

  TRUNCATE TABLE referral_leaderboard_snapshot_entries;

  INSERT INTO referral_leaderboard_snapshot_entries (
    rank,
    user_id,
    address,
    total_points,
    referral_points,
    referred_users,
    refreshed_at
  )
  SELECT
    snapshot.rank,
    snapshot.user_id,
    snapshot.address,
    snapshot.total_points,
    snapshot.referral_points,
    snapshot.referred_users,
    snapshot.refreshed_at
  FROM tmp_referral_leaderboard_snapshot AS snapshot
  ORDER BY snapshot.rank;

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
