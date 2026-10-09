-- Only an authenticated designated launcher can prepare a future official launch.
-- Intents do not reserve the official slot. The first verified actual launch wins it once.
CREATE TABLE memefun_app.platform_token_intent (
  chain_id integer NOT NULL,
  factory text NOT NULL,
  coin text NOT NULL,
  launcher text NOT NULL,
  salt text NOT NULL,
  contract_uri text NOT NULL,
  after_block numeric(78, 0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, factory, coin),
  UNIQUE (chain_id, factory, salt)
);

CREATE TABLE memefun_app.platform_token_pin (
  chain_id integer NOT NULL,
  factory text NOT NULL,
  coin text NOT NULL,
  launcher text NOT NULL,
  contract_uri text NOT NULL,
  launch_block numeric(78, 0) NOT NULL,
  log_index integer NOT NULL,
  tx_hash text NOT NULL,
  block_hash text NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, factory),
  FOREIGN KEY (chain_id, factory, coin) REFERENCES memefun_app.platform_token_intent (chain_id, factory, coin)
);

CREATE TABLE memefun_app.platform_token_quota (
  key text NOT NULL,
  window_start bigint NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX platform_token_quota_expiry_idx ON memefun_app.platform_token_quota (expires_at);
