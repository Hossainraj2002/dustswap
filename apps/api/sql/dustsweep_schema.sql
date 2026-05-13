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
create index if not exists idx_tokens_chain_active on public.tokens(chain_id, is_active);
create index if not exists idx_tokens_liquidity on public.tokens(chain_id, liquidity_usd desc);
create unique index if not exists idx_tokens_address_unique on public.tokens(address);
create unique index if not exists idx_sweeps_tx_hash_unique on public.sweeps(tx_hash);

create table if not exists public.dustsweep_token_cache (
  address    text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

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

-- ── NOTE ────────────────────────────────────────────────────────────────────
-- The `tokens` table is used as a METADATA and LIQUIDITY HINT registry.
-- It is NOT a visibility gate. All wallet ERC-20 balances are shown to users
-- regardless of whether the token exists in this table. Whitelist sync scripts
-- populate metadata (logos, bestDex, liquidity) that enriches the UI.
