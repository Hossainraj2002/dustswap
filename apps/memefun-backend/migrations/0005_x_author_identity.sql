-- Server-owned X verification. OAuth credentials never belong in public metadata or sessions.
CREATE TABLE IF NOT EXISTS memefun_app.x_oauth_state (
  state_hash text PRIMARY KEY,
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  code_verifier text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_oauth_state_expiry_idx ON memefun_app.x_oauth_state (expires_at);

-- A fresh secret is delivered only to the returning browser, then completed by the same SIWE
-- wallet. Forwarding an authorization URL must not bind a victim's X account to its starter.
CREATE TABLE IF NOT EXISTS memefun_app.x_oauth_completion (
  token_hash text PRIMARY KEY,
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  author jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_oauth_completion_expiry_idx ON memefun_app.x_oauth_completion (expires_at);

-- The stable numeric X ID comes only from official OAuth /users/me. Handles are display data.
CREATE TABLE IF NOT EXISTS memefun_app.x_author_identity (
  wallet text PRIMARY KEY CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  x_user_id text NOT NULL CHECK (x_user_id ~ '^[0-9]{1,32}$'),
  handle text NOT NULL,
  display_name text NOT NULL,
  avatar_url text,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_author_identity_user_idx ON memefun_app.x_author_identity (x_user_id);

-- A shared provider cache and request quota bound costs across API replicas.
CREATE TABLE IF NOT EXISTS memefun_app.x_post_cache (
  post_id text PRIMARY KEY CHECK (post_id ~ '^[0-9]{1,32}$'),
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS x_post_cache_expiry_idx ON memefun_app.x_post_cache (expires_at);
-- A signed launch's public source snapshot remains available after the short provider cache expires.
CREATE TABLE IF NOT EXISTS memefun_app.x_tweet_source (
  post_id text PRIMARY KEY CHECK (post_id ~ '^[0-9]{1,32}$'),
  author_x_user_id text NOT NULL CHECK (author_x_user_id ~ '^[0-9]{1,32}$'),
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memefun_app.x_request_quota (
  key text NOT NULL,
  window_start bigint NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS x_request_quota_expiry_idx ON memefun_app.x_request_quota (expires_at);
