CREATE TABLE IF NOT EXISTS partner_content_submissions (
  id                BIGSERIAL PRIMARY KEY,
  partner_member_id BIGINT NOT NULL REFERENCES partner_program_members(id) ON DELETE CASCADE,
  partner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_url       TEXT NOT NULL,
  normalized_url    TEXT NOT NULL,
  platform          TEXT NOT NULL DEFAULT 'other',
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_content_submissions_platform_check
    CHECK (platform IN ('x', 'telegram', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_partner_content_submissions_member_submitted
  ON partner_content_submissions(partner_member_id, submitted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_content_submissions_member_url
  ON partner_content_submissions(partner_member_id, normalized_url);

ALTER TABLE partner_content_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_partner_content_submissions" ON partner_content_submissions;

CREATE POLICY "service_all_partner_content_submissions"
  ON partner_content_submissions FOR ALL USING (true);
