-- Official X OAuth + GetX verification migration.
-- Additive only: existing users, profile usernames, points, referrals, swaps, and
-- quest progress stay in place.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users ADD COLUMN IF NOT EXISTS x_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS x_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS x_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS x_avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS x_connected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS x_connected_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_x_user_id_unique
ON users (x_user_id)
WHERE x_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_states (
  id             BIGSERIAL PRIMARY KEY,
  state_hash     TEXT NOT NULL UNIQUE,
  platform       TEXT NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address VARCHAR(42) NOT NULL,
  return_to      TEXT NOT NULL,
  code_verifier  TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_state
ON oauth_states (state_hash, platform, consumed_at);

CREATE TABLE IF NOT EXISTS app_migration_runs (
  key      TEXT PRIMARY KEY,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ran_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE quest_progress ADD COLUMN IF NOT EXISTS verified_by_api BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE quest_progress ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS footprint_social_verifications (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address     VARCHAR(42) NOT NULL,
  task_key           TEXT NOT NULL,
  platform           TEXT NOT NULL DEFAULT 'x',
  source_x_user_id   TEXT NOT NULL,
  target_x_user_id   TEXT NOT NULL,
  target_username    TEXT,
  verified_by_api    BOOLEAN NOT NULL DEFAULT false,
  verified_at        TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, task_key, platform)
);

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_migration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE footprint_social_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_oauth_states" ON oauth_states;
CREATE POLICY "service_all_oauth_states"
ON oauth_states
FOR ALL
USING (true);

DROP POLICY IF EXISTS "service_all_app_migration_runs"
ON app_migration_runs;
CREATE POLICY "service_all_app_migration_runs"
ON app_migration_runs
FOR ALL
USING (true);

DROP POLICY IF EXISTS "service_all_footprint_social_verifications"
ON footprint_social_verifications;
CREATE POLICY "service_all_footprint_social_verifications"
ON footprint_social_verifications
FOR ALL
USING (true);
