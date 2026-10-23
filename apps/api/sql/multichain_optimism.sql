-- DustSweep OP Mainnet (chainId 10). Additive, transactional and idempotent.
-- Prerequisites: dustsweep_schema.sql and multichain_ethereum.sql (chain/address uniqueness).
-- Apply before adding 10 to DUST_SWEEP_ENABLED_CHAIN_IDS, then run multichain_optimism_verify.sql.
-- These rows are metadata hints, not a discovery visibility gate. Native USDC, bridged USDC.e,
-- legacy USDT and USDT0 are distinct tokens. No existing chain's rows are modified.
-- Symbols/decimals checked on-chain 2026-10-12: bridged USDC.e reports USDC; USDT0 reports USD₮0.

BEGIN;

-- Fail with a useful message rather than removing another chain's uniqueness constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public' AND t.relname = 'tokens'
      AND c.contype = 'u' AND array_length(c.conkey, 1) = 1 AND a.attname = 'address'
  ) OR EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'public' AND t.relname = 'tokens'
      AND i.indisunique AND i.indnkeyatts = 1 AND a.attname = 'address'
  ) THEN
    RAISE EXCEPTION 'Apply multichain_ethereum.sql before Optimism: tokens(address) must be unique per chain, not globally';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_chain_address_unique ON public.tokens(chain_id, address);

INSERT INTO public.chain_registry
  (chain_id, chain_slug, name, native_token_id, wrapped_token_address, explorer_url)
VALUES
  (10, 'optimism', 'Optimism', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
   '0x4200000000000000000000000000000000000006', 'https://optimistic.etherscan.io')
ON CONFLICT (chain_id) DO UPDATE SET
  chain_slug = EXCLUDED.chain_slug,
  name = EXCLUDED.name,
  native_token_id = EXCLUDED.native_token_id,
  wrapped_token_address = EXCLUDED.wrapped_token_address,
  explorer_url = EXCLUDED.explorer_url,
  updated_at = now();

INSERT INTO public.tokens
  (address, symbol, name, decimals, logo_uri, chain_id, is_active, source, liquidity_usd)
VALUES
  ('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC', 'USD Coin', 6, 'https://token-icons.llamao.fi/icons/tokens/10/0x0b2c639c533813f4aa9d7837caf62653d097ff85?h=48&w=48', 10, true, 'seed', 50000000),
  ('0x4200000000000000000000000000000000000006', 'WETH', 'Wrapped Ether', 18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png', 10, true, 'seed', 50000000),
  ('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'USDT', 'Tether USD', 6, 'https://token-icons.llamao.fi/icons/tokens/10/0x94b008aa00579c1307b0ef2c499ad98a8ce58e58?h=48&w=48', 10, true, 'seed', 50000000),
  ('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI', 'Dai Stablecoin', 18, 'https://token-icons.llamao.fi/icons/tokens/10/0xda10009cbd5d07dd0cecc66161fc93d7c9000da1?h=48&w=48', 10, true, 'seed', 1000000),
  ('0x68f180fcCe6836688e9084f035309E29Bf0A2095', 'WBTC', 'Wrapped BTC', 8, 'https://token-icons.llamao.fi/icons/tokens/10/0x68f180fcce6836688e9084f035309e29bf0a2095?h=48&w=48', 10, true, 'seed', 1000000),
  ('0x4200000000000000000000000000000000000042', 'OP', 'Optimism', 18, 'https://token-icons.llamao.fi/icons/tokens/10/0x4200000000000000000000000000000000000042?h=48&w=48', 10, true, 'seed', 1000000),
  ('0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 'USDC', 'Bridged USDC (Optimism)', 6, 'https://token-icons.llamao.fi/icons/tokens/10/0x7f5c764cbc14f9669b88837ca1490cca17c31607?h=48&w=48', 10, true, 'seed', 1000000),
  ('0x01bFF41798a0BcF287b996046Ca68b395DbC1071', 'USD₮0', 'USDT0', 6, 'https://token-icons.llamao.fi/icons/tokens/10/0x01bff41798a0bcf287b996046ca68b395dbc1071?h=48&w=48', 10, true, 'seed', 1000000)
ON CONFLICT (chain_id, address) DO UPDATE SET
  symbol = EXCLUDED.symbol,
  name = EXCLUDED.name,
  decimals = EXCLUDED.decimals,
  logo_uri = EXCLUDED.logo_uri,
  is_active = EXCLUDED.is_active,
  liquidity_usd = EXCLUDED.liquidity_usd,
  last_checked = now();

COMMIT;
