CREATE TABLE IF NOT EXISTS user_onboarding_guides (
  id                     BIGSERIAL PRIMARY KEY,
  wallet_address         VARCHAR(42) NOT NULL,
  guide_key              TEXT NOT NULL,
  guide_version          INTEGER NOT NULL DEFAULT 1,
  first_seen_at          TIMESTAMPTZ,
  last_seen_at           TIMESTAMPTZ,
  modal_impression_count INTEGER NOT NULL DEFAULT 0,
  dismiss_count          INTEGER NOT NULL DEFAULT 0,
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_address, guide_key)
);

CREATE INDEX IF NOT EXISTS idx_user_onboarding_guides_wallet_guide
  ON user_onboarding_guides(wallet_address, guide_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_point_events_profile_completion_reward_once
  ON point_events(user_id, action)
  WHERE action = 'profile_completion_reward_v1';

ALTER TABLE user_onboarding_guides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_user_onboarding_guides" ON user_onboarding_guides;

CREATE POLICY "service_all_user_onboarding_guides"
  ON user_onboarding_guides
  FOR ALL
  USING (true);
