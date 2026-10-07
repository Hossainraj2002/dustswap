-- Slots are reproducible from finalized onchain launch order, independent of claim requests.
-- Only HTTP attempt budgets need mutable application state; replicas share the same counters.
CREATE TABLE memefun_app.launch_campaign_quota (
  key text NOT NULL,
  window_start bigint NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX launch_campaign_quota_expiry_idx ON memefun_app.launch_campaign_quota (expires_at);
