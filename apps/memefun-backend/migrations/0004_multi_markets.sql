-- Retain legacy coin-bound proofs; new epochs bind each leaf and payout to a specific pool.
ALTER TABLE memefun_app.reward_epoch_coin ADD COLUMN IF NOT EXISTS pool_id text;
ALTER TABLE memefun_app.reward_leaf ADD COLUMN IF NOT EXISTS pool_id text;
ALTER TABLE memefun_app.reward_epoch_coin DROP CONSTRAINT IF EXISTS reward_epoch_coin_pkey;
ALTER TABLE memefun_app.reward_leaf DROP CONSTRAINT IF EXISTS reward_leaf_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS reward_epoch_coin_identity_idx
  ON memefun_app.reward_epoch_coin (epoch, COALESCE(pool_id, coin));
CREATE UNIQUE INDEX IF NOT EXISTS reward_leaf_identity_idx
  ON memefun_app.reward_leaf (epoch, COALESCE(pool_id, coin), idx);
