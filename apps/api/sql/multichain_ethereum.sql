-- Multichain expansion: Ethereum mainnet (chainId 1) support for DustSweep.
--
-- ADDITIVE + IDEMPOTENT. Safe to run multiple times. Does NOT touch Base (8453) data.
-- Apply BEFORE flipping DUST_SWEEP_ENABLED_CHAIN_IDS=8453,1.
--
-- What it does:
--   1. Re-keys the `tokens` whitelist uniqueness from (address) to (chain_id, address) so the
--      same address can exist on multiple chains. The app upserts now use onConflict
--      "chain_id,address" to match.
--   2. Registers Ethereum in chain_registry.
--   3. Seeds a minimal Ethereum whitelist (hints only: decimals + liquidity for stables/majors).

BEGIN;

-- 1. tokens uniqueness: (chain_id, address) ------------------------------------------------
-- Drop the known Base-only address-unique constraint + index by name...
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_address_key;
DROP INDEX IF EXISTS idx_tokens_address_unique;
-- ...and defensively drop ANY other single-column UNIQUE constraint on tokens(address), whatever
-- it was named, so a non-standard name can't silently leave the old constraint in place (which
-- would block a token that shares an address across chains).
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t   ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'tokens'
      AND c.contype = 'u' AND array_length(c.conkey, 1) = 1
      AND (SELECT attname FROM pg_attribute WHERE attrelid = t.oid AND attnum = c.conkey[1]) = 'address'
  LOOP
    EXECUTE format('ALTER TABLE public.tokens DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_chain_address_unique ON tokens(chain_id, address);

-- 2. chain_registry: Ethereum --------------------------------------------------------------
-- chain_registry lives in sql/dustsweep_schema.sql; guard in case that schema isn't applied here.
INSERT INTO chain_registry (chain_id, chain_slug, name, native_token_id, wrapped_token_address, explorer_url)
SELECT 1,
       'ethereum',
       'Ethereum',
       '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
       '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
       'https://etherscan.io'
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'chain_registry'
)
ON CONFLICT (chain_id) DO UPDATE SET
  chain_slug = EXCLUDED.chain_slug,
  name = EXCLUDED.name,
  native_token_id = EXCLUDED.native_token_id,
  wrapped_token_address = EXCLUDED.wrapped_token_address,
  explorer_url = EXCLUDED.explorer_url,
  updated_at = now();

-- 3. Minimal Ethereum whitelist seed (hints only) ------------------------------------------
INSERT INTO tokens (address, symbol, name, decimals, chain_id, is_active, source, liquidity_usd)
VALUES
  ('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 'USD Coin',      6,  1, true, 'seed', 50000000),
  ('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 'Tether USD',    6,  1, true, 'seed', 50000000),
  ('0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI',  'Dai Stablecoin',18, 1, true, 'seed', 50000000),
  ('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH', 'Wrapped Ether', 18, 1, true, 'seed', 50000000),
  ('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 'Wrapped BTC',   8,  1, true, 'seed', 50000000)
ON CONFLICT (chain_id, address) DO UPDATE SET
  symbol = EXCLUDED.symbol,
  name = EXCLUDED.name,
  decimals = EXCLUDED.decimals,
  is_active = EXCLUDED.is_active,
  liquidity_usd = EXCLUDED.liquidity_usd,
  last_checked = now();

COMMIT;
