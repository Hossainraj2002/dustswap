ALTER TABLE users
  ADD COLUMN IF NOT EXISTS spin_tickets INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS spin_history (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id),
  tx_hash            VARCHAR(66) UNIQUE NOT NULL,
  reward_key         VARCHAR(32) NOT NULL,
  reward_label       VARCHAR(32) NOT NULL,
  reward_type        VARCHAR(10) NOT NULL,
  reward_amount      DECIMAL(20,6) NOT NULL,
  reward_points      INTEGER NOT NULL DEFAULT 0,
  reward_probability DECIMAL(5,2) NOT NULL DEFAULT 0,
  ticket_cost        INTEGER NOT NULL DEFAULT 1,
  execution_type     VARCHAR(20),
  status             VARCHAR(20) NOT NULL DEFAULT 'confirmed',
  created_at         TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spin_history_user_created
  ON spin_history(user_id, created_at DESC);

ALTER TABLE spin_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_spin_history" ON spin_history;
CREATE POLICY "service_all_spin_history" ON spin_history FOR ALL USING (true);

CREATE OR REPLACE FUNCTION adjust_spin_tickets(
  p_user_id INTEGER,
  p_delta INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_next_tickets INTEGER;
BEGIN
  UPDATE users
  SET
    spin_tickets = spin_tickets + p_delta,
    updated_at = NOW()
  WHERE
    id = p_user_id
    AND spin_tickets + p_delta >= 0
  RETURNING spin_tickets INTO v_next_tickets;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient_spin_tickets';
  END IF;

  RETURN v_next_tickets;
END;
$$;
