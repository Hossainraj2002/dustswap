-- Multi-chain swap capture indexes/constraints.
-- Apply before relying on duplicate tx-hash handling across chains.
-- This version is compatible with SQL runners that wrap scripts in a transaction,
-- including the Supabase SQL editor. The CREATE INDEX statements may briefly lock
-- writes on these tables, so run during a low-traffic window.

CREATE UNIQUE INDEX IF NOT EXISTS idx_swap_transactions_chain_tx_hash_unique
  ON swap_transactions(chain_id, tx_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_chain_tx_event_source_unique
  ON activity_events(chain_id, tx_hash, event_type, source);

CREATE INDEX IF NOT EXISTS idx_activity_events_swap_filters
  ON activity_events(user_id, event_type, source, chain_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_sweep_history_chain_tx_hash_type
  ON sweep_history(chain_id, tx_hash, type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sweep_history_swap_chain_tx_unique
  ON sweep_history(COALESCE(chain_id, -1), LOWER(tx_hash))
  WHERE type = 'swap' AND tx_hash IS NOT NULL;

-- Drop legacy global tx-hash uniqueness after the chain-aware indexes exist.
ALTER TABLE swap_transactions
  DROP CONSTRAINT IF EXISTS swap_transactions_tx_hash_key;

ALTER TABLE activity_events
  DROP CONSTRAINT IF EXISTS activity_events_tx_hash_event_type_source_key;
