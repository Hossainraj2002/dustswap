-- memefun_app: everything the backend owns that is not on chain. Ponder's tables live in their
-- own schema; nothing here is written by the indexer.

CREATE SCHEMA IF NOT EXISTS memefun_app;

-- Sanitized coin metadata documents, by the CID of the JSON (`ipfs://<cid>` is the contractURI).
-- `source` is 'api' for documents created through POST /v1/media/metadata, 'fetched' for those
-- the keeper pulled from IPFS for coins launched elsewhere.
CREATE TABLE IF NOT EXISTS memefun_app.metadata (
  cid          text PRIMARY KEY,
  name         text NOT NULL DEFAULT '',
  symbol       text NOT NULL DEFAULT '',
  description  text NOT NULL DEFAULT '',
  image_uri    text,
  links        jsonb NOT NULL DEFAULT '{}'::jsonb,
  source       text NOT NULL CHECK (source IN ('api', 'fetched')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Resolution state of each coin's contractURI (filled by the keeper's metadata job).
CREATE TABLE IF NOT EXISTS memefun_app.coin_metadata (
  coin          text PRIMARY KEY,
  contract_uri  text NOT NULL,
  cid           text REFERENCES memefun_app.metadata (cid),
  status        text NOT NULL CHECK (status IN ('resolved', 'pending', 'failed', 'unsupported')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  next_attempt  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coin_metadata_due_idx ON memefun_app.coin_metadata (status, next_attempt);

-- Every object the API stored (images and metadata), for dedupe, quotas and abuse review.
CREATE TABLE IF NOT EXISTS memefun_app.upload (
  cid          text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('image', 'metadata')),
  bytes        integer NOT NULL,
  uploader     text,
  ip_hash      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upload_ip_idx ON memefun_app.upload (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS memefun_app.comment (
  id           bigserial PRIMARY KEY,
  coin         text NOT NULL,
  author       text NOT NULL,
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 280),
  hidden       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comment_coin_idx ON memefun_app.comment (coin, created_at DESC);
CREATE INDEX IF NOT EXISTS comment_author_idx ON memefun_app.comment (author, created_at DESC);

CREATE TABLE IF NOT EXISTS memefun_app.report (
  id           bigserial PRIMARY KEY,
  target_kind  text NOT NULL CHECK (target_kind IN ('coin', 'comment')),
  target_id    text NOT NULL,
  reason       text NOT NULL,
  details      text NOT NULL DEFAULT '',
  reporter     text,
  ip_hash      text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS report_status_idx ON memefun_app.report (status, created_at);

-- Admin moderation per coin: hidden coins vanish from every list and the tape, featured coins
-- are pinned on Discover. Nothing here touches the chain; a hidden coin still trades.
CREATE TABLE IF NOT EXISTS memefun_app.moderation (
  coin        text PRIMARY KEY,
  hidden      boolean NOT NULL DEFAULT false,
  featured    boolean NOT NULL DEFAULT false,
  note        text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Small admin-set values, e.g. the site banner.
CREATE TABLE IF NOT EXISTS memefun_app.setting (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Holder-reward epochs as the keeper built them: the full leaf set behind each published root,
-- so the API can hand every holder their proof and anyone can recompute the root.
CREATE TABLE IF NOT EXISTS memefun_app.reward_epoch (
  epoch          bigint PRIMARY KEY,
  window_start   bigint NOT NULL,
  window_end     bigint NOT NULL,
  root           text NOT NULL,
  leaves         integer NOT NULL,
  status         text NOT NULL CHECK (status IN ('built', 'published', 'failed')),
  leaves_uri     text,
  tx_hash        text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);

CREATE TABLE IF NOT EXISTS memefun_app.reward_epoch_coin (
  epoch    bigint NOT NULL REFERENCES memefun_app.reward_epoch (epoch),
  coin     text NOT NULL,
  pot      numeric(78, 0) NOT NULL,
  total    numeric(78, 0) NOT NULL,
  holders  integer NOT NULL,
  PRIMARY KEY (epoch, coin)
);

CREATE TABLE IF NOT EXISTS memefun_app.reward_leaf (
  epoch    bigint NOT NULL REFERENCES memefun_app.reward_epoch (epoch),
  coin     text NOT NULL,
  idx      bigint NOT NULL,
  account  text NOT NULL,
  amount   numeric(78, 0) NOT NULL,
  proof    jsonb NOT NULL,
  PRIMARY KEY (epoch, coin, idx)
);
CREATE INDEX IF NOT EXISTS reward_leaf_account_idx ON memefun_app.reward_leaf (account);

-- Balances at each epoch's end, so the next epoch replays only its own window's transfers.
CREATE TABLE IF NOT EXISTS memefun_app.reward_snapshot (
  epoch    bigint NOT NULL,
  coin     text NOT NULL,
  account  text NOT NULL,
  amount   numeric(78, 0) NOT NULL,
  PRIMARY KEY (epoch, coin, account)
);

-- One row per keeper action, for operations and the admin page.
CREATE TABLE IF NOT EXISTS memefun_app.keeper_run (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  target      text,
  status      text NOT NULL CHECK (status IN ('ok', 'skipped', 'failed', 'dry_run')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  tx_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS keeper_run_job_idx ON memefun_app.keeper_run (job, created_at DESC);
