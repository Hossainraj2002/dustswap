-- DustSweep-only migration for Supabase.
-- Safe to run on a live database: it only creates missing tables/indexes.

create table if not exists public.tokens (
  id            serial primary key,
  address       text not null unique,
  symbol        text not null,
  name          text not null,
  decimals      integer not null default 18,
  logo_uri      text,
  chain_id      integer not null default 8453,
  is_active     boolean default true,
  source        text,
  liquidity_usd numeric,
  last_checked  timestamptz default now(),
  created_at    timestamptz default now()
);

alter table public.tokens add column if not exists address text;
alter table public.tokens add column if not exists symbol text;
alter table public.tokens add column if not exists name text;
alter table public.tokens add column if not exists decimals integer not null default 18;
alter table public.tokens add column if not exists logo_uri text;
alter table public.tokens add column if not exists chain_id integer not null default 8453;
alter table public.tokens add column if not exists is_active boolean default true;
alter table public.tokens add column if not exists source text;
alter table public.tokens add column if not exists liquidity_usd numeric;
alter table public.tokens add column if not exists last_checked timestamptz default now();
alter table public.tokens add column if not exists created_at timestamptz default now();

create table if not exists public.sweeps (
  id              serial primary key,
  user_address    text not null,
  tx_hash         text unique,
  tokens_in       jsonb,
  token_out       text,
  amount_out      text,
  value_usd       numeric,
  fee_usd         numeric,
  tokens_swapped  integer,
  tokens_failed   integer,
  chain_id        integer default 8453,
  created_at      timestamptz default now()
);

alter table public.sweeps add column if not exists user_address text;
alter table public.sweeps add column if not exists tx_hash text;
alter table public.sweeps add column if not exists tokens_in jsonb;
alter table public.sweeps add column if not exists token_out text;
alter table public.sweeps add column if not exists amount_out text;
alter table public.sweeps add column if not exists value_usd numeric;
alter table public.sweeps add column if not exists fee_usd numeric;
alter table public.sweeps add column if not exists tokens_swapped integer;
alter table public.sweeps add column if not exists tokens_failed integer;
alter table public.sweeps add column if not exists chain_id integer default 8453;
alter table public.sweeps add column if not exists created_at timestamptz default now();

create index if not exists idx_sweeps_user on public.sweeps(user_address);
-- Speeds windowed (daily/weekly) sweep-quest progress queries.
create index if not exists idx_sweeps_user_created on public.sweeps(user_address, created_at);
create index if not exists idx_tokens_chain_active on public.tokens(chain_id, is_active);
create index if not exists idx_tokens_liquidity on public.tokens(chain_id, liquidity_usd desc);
create unique index if not exists idx_tokens_address_unique on public.tokens(address);
create unique index if not exists idx_sweeps_tx_hash_unique on public.sweeps(tx_hash);

create table if not exists public.dustsweep_token_cache (
  address    text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.chain_registry (
  chain_id              integer primary key,
  chain_slug            text not null unique,
  name                  text not null,
  native_token_id       text not null,
  wrapped_token_address text not null,
  explorer_url          text,
  updated_at            timestamptz not null default now()
);

insert into public.chain_registry (
  chain_id,
  chain_slug,
  name,
  native_token_id,
  wrapped_token_address,
  explorer_url
) values (
  8453,
  'base',
  'Base',
  '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  '0x4200000000000000000000000000000000000006',
  'https://basescan.org'
) on conflict (chain_id) do update set
  chain_slug = excluded.chain_slug,
  name = excluded.name,
  native_token_id = excluded.native_token_id,
  wrapped_token_address = excluded.wrapped_token_address,
  explorer_url = excluded.explorer_url,
  updated_at = now();

create table if not exists public.token_metadata (
  chain_id              integer not null,
  token_address         text not null,
  is_native             boolean not null default false,
  wrapped_token_address text,
  name                  text,
  symbol                text,
  display_symbol        text,
  optimized_symbol      text,
  decimals              integer,
  logo_url              text,
  verified_contract     boolean not null default false,
  deployed_at           timestamptz,
  protocol_id           text,
  updated_at            timestamptz not null default now(),
  primary key (chain_id, token_address)
);

create table if not exists public.token_prices (
  chain_id      integer not null,
  token_address text not null,
  price_usd     numeric not null default 0,
  source        text not null,
  confidence    text not null default 'NONE',
  updated_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  primary key (chain_id, token_address)
);

create table if not exists public.token_liquidity (
  chain_id           integer not null,
  token_address      text not null,
  has_dex_liquidity  boolean not null default false,
  best_venue         text,
  best_liquidity_usd numeric not null default 0,
  quoteable_hint     boolean,
  updated_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  primary key (chain_id, token_address)
);

create table if not exists public.token_risk_flags (
  chain_id           integer not null,
  token_address      text not null,
  risk_score         integer not null default 0,
  hidden_by_default  boolean not null default false,
  blocked_from_sweep boolean not null default false,
  reasons            jsonb not null default '[]'::jsonb,
  manual_override    jsonb,
  updated_at         timestamptz not null default now(),
  primary key (chain_id, token_address)
);

create table if not exists public.wallet_token_balances (
  chain_id         integer not null,
  wallet_address   text not null,
  token_address    text not null,
  source_type      text not null,
  raw_amount       text not null,
  formatted_amount numeric,
  usd_value        numeric not null default 0,
  discovered_at    timestamptz not null default now(),
  metadata_version text,
  primary key (chain_id, wallet_address, token_address, source_type)
);

create table if not exists public.wallet_discovery_jobs (
  id             uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  chain_id       integer not null default 8453,
  status         text not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  error          text,
  requested_by   text
);

create table if not exists public.token_quote_cache (
  chain_id      integer not null,
  token_in      text not null,
  token_out     text not null,
  amount_bucket text not null,
  status        text not null,
  source        text,
  payload       jsonb,
  expires_at    timestamptz not null,
  updated_at    timestamptz not null default now(),
  primary key (chain_id, token_in, token_out, amount_bucket)
);

create index if not exists idx_wallet_token_balances_wallet_value
  on public.wallet_token_balances(wallet_address, usd_value desc);
create index if not exists idx_token_prices_expires
  on public.token_prices(expires_at);
create index if not exists idx_token_liquidity_expires
  on public.token_liquidity(expires_at);
create index if not exists idx_token_quote_cache_expires
  on public.token_quote_cache(expires_at);

insert into public.tokens (address, symbol, name, decimals, logo_uri, chain_id, is_active, source, liquidity_usd)
values
  ('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 'USD Coin', 6, 'https://basescan.org/token/images/centre-usdc_28.png', 8453, true, 'default', 50000000),
  ('0x4200000000000000000000000000000000000006', 'WETH', 'Wrapped Ether', 18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png', 8453, true, 'default', 50000000)
on conflict (address) do update set
  symbol = excluded.symbol,
  name = excluded.name,
  decimals = excluded.decimals,
  logo_uri = excluded.logo_uri,
  chain_id = excluded.chain_id,
  is_active = excluded.is_active,
  source = excluded.source,
  liquidity_usd = excluded.liquidity_usd,
  last_checked = now();

-- ── Routeability cache ──────────────────────────────────────────────────────
-- Short-lived cache for routing results. Used to avoid re-quoting tokens
-- that were recently checked. The runtime cache (in-memory) is the primary
-- layer; this DB table provides persistence across server restarts.
create table if not exists public.dustsweep_routeability_cache (
  chain_id       integer not null,
  token_in       text not null,
  token_out      text not null,
  amount_bucket  text not null,
  source         text,
  status         text not null,
  payload        jsonb,
  expires_at     timestamptz not null,
  updated_at     timestamptz not null default now(),
  primary key (chain_id, token_in, token_out, amount_bucket)
);

create index if not exists idx_routeability_expires
  on public.dustsweep_routeability_cache(expires_at);

alter table public.chain_registry enable row level security;
alter table public.token_metadata enable row level security;
alter table public.token_prices enable row level security;
alter table public.token_liquidity enable row level security;
alter table public.token_risk_flags enable row level security;
alter table public.wallet_token_balances enable row level security;
alter table public.wallet_discovery_jobs enable row level security;
alter table public.token_quote_cache enable row level security;
alter table public.dustsweep_routeability_cache enable row level security;

drop policy if exists "service_all_chain_registry" on public.chain_registry;
drop policy if exists "service_all_token_metadata" on public.token_metadata;
drop policy if exists "service_all_token_prices" on public.token_prices;
drop policy if exists "service_all_token_liquidity" on public.token_liquidity;
drop policy if exists "service_all_token_risk_flags" on public.token_risk_flags;
drop policy if exists "service_all_wallet_token_balances" on public.wallet_token_balances;
drop policy if exists "service_all_wallet_discovery_jobs" on public.wallet_discovery_jobs;
drop policy if exists "service_all_token_quote_cache" on public.token_quote_cache;
drop policy if exists "service_all_routeability_cache" on public.dustsweep_routeability_cache;

create policy "service_all_chain_registry" on public.chain_registry for all using (true);
create policy "service_all_token_metadata" on public.token_metadata for all using (true);
create policy "service_all_token_prices" on public.token_prices for all using (true);
create policy "service_all_token_liquidity" on public.token_liquidity for all using (true);
create policy "service_all_token_risk_flags" on public.token_risk_flags for all using (true);
create policy "service_all_wallet_token_balances" on public.wallet_token_balances for all using (true);
create policy "service_all_wallet_discovery_jobs" on public.wallet_discovery_jobs for all using (true);
create policy "service_all_token_quote_cache" on public.token_quote_cache for all using (true);
create policy "service_all_routeability_cache" on public.dustsweep_routeability_cache for all using (true);

-- ── NOTE ────────────────────────────────────────────────────────────────────
-- The `tokens` table is used as a METADATA and LIQUIDITY HINT registry.
-- It is NOT a visibility gate. All wallet ERC-20 balances are shown to users
-- regardless of whether the token exists in this table. Whitelist sync scripts
-- populate metadata (logos, bestDex, liquidity) that enriches the UI.
