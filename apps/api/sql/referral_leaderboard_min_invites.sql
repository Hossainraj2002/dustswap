CREATE OR REPLACE FUNCTION get_referral_leaderboard_page(
  p_offset INTEGER,
  p_limit INTEGER
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
    ranked.referred_users
  FROM ranked
  ORDER BY ranked.rank
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

CREATE OR REPLACE FUNCTION get_referral_leaderboard_count()
RETURNS TABLE (
  total_entries BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH referral_counts AS (
    SELECT referrer_id AS user_id, COUNT(*)::BIGINT AS referred_users
    FROM referrals
    WHERE referrer_id IS NOT NULL
    GROUP BY referrer_id
  )
  SELECT COUNT(*)::BIGINT AS total_entries
  FROM users u
  JOIN referral_counts ON referral_counts.user_id = u.id
  WHERE referral_counts.referred_users > 0;
$$;

CREATE OR REPLACE FUNCTION get_referral_leaderboard_viewer(p_user_id INTEGER)
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
    ranked.referred_users
  FROM ranked
  WHERE ranked.user_id = p_user_id
  LIMIT 1;
$$;
