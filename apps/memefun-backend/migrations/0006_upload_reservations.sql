-- The content-addressed upload ledger deduplicates CIDs. Quotas must count each admitted request.
CREATE TABLE IF NOT EXISTS memefun_app.upload_reservation (
  id bigserial PRIMARY KEY,
  quota_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS upload_reservation_key_time_idx ON memefun_app.upload_reservation (quota_key, created_at);

-- Preserve the previous last-hour charge when applying this append-only migration.
INSERT INTO memefun_app.upload_reservation (quota_key, created_at)
SELECT 'wallet:' || lower(uploader), created_at
FROM memefun_app.upload
WHERE created_at > now() - interval '1 hour' AND uploader IS NOT NULL
UNION ALL
SELECT 'ip:' || ip_hash, created_at
FROM memefun_app.upload
WHERE created_at > now() - interval '1 hour' AND ip_hash IS NOT NULL;
