-- Atomic daily swap volume upsert
-- Run this file after swap_volume_schema.sql in the Supabase SQL editor.

CREATE OR REPLACE FUNCTION upsert_daily_volume(
  p_user_id INTEGER,
  p_address VARCHAR,
  p_day_key DATE,
  p_week_key TEXT,
  p_amount_usd DECIMAL(20,6)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO user_volume_daily (
    user_id,
    address,
    day_key,
    week_key,
    total_usd,
    swap_count
  )
  VALUES (
    p_user_id,
    LOWER(p_address),
    p_day_key,
    p_week_key,
    p_amount_usd,
    1
  )
  ON CONFLICT (user_id, day_key)
  DO UPDATE SET
    address = EXCLUDED.address,
    week_key = EXCLUDED.week_key,
    total_usd = user_volume_daily.total_usd + EXCLUDED.total_usd,
    swap_count = user_volume_daily.swap_count + 1,
    updated_at = NOW();
END;
$$;
