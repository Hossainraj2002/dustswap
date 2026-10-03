-- Holder-reward epochs compute start-of-window balances directly from the indexed transfers
-- (one aggregate per coin), so per-epoch balance snapshots are not needed.
DROP TABLE IF EXISTS memefun_app.reward_snapshot;
