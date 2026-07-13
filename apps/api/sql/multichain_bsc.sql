-- Multichain expansion: BNB Smart Chain (chainId 56) support for DustSweep.
--
-- ADDITIVE + IDEMPOTENT. Safe to run multiple times. Does NOT touch Base (8453) or Ethereum (1)
-- data (except the opt-in logo backfill in §4, which only fills NULL logo_uri on seed rows).
-- Apply BEFORE flipping DUST_SWEEP_ENABLED_CHAIN_IDS=8453,1,56.
--
-- What it does:
--   1. Ensures the (chain_id, address) uniqueness from multichain_ethereum.sql is in place
--      (no-op when that migration already ran).
--   2. Registers BNB Smart Chain in chain_registry.
--   3. Seeds a minimal BSC whitelist WITH logo_uri (the Ethereum seeds shipped without logos and
--      rendered logo-less — lesson applied). NOTE: USDT/USDC/DAI are 18 DECIMALS on BSC.
--   4. Backfills logo_uri for the Ethereum seed rows that shipped without one.
--
-- All addresses verified live 2026-07-10 via eth_getCode + decimals()/symbol() eth_calls on
-- bsc-dataseed.bnbchain.org (chainId 0x38) — never explorer labels.

BEGIN;

-- 1. tokens uniqueness: (chain_id, address) ------------------------------------------------
-- Same defensive block as multichain_ethereum.sql; harmless if it already ran.
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_address_key;
DROP INDEX IF EXISTS idx_tokens_address_unique;
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

-- 2. chain_registry: BNB Smart Chain --------------------------------------------------------
INSERT INTO chain_registry (chain_id, chain_slug, name, native_token_id, wrapped_token_address, explorer_url)
SELECT 56,
       'bsc',
       'BNB Smart Chain',
       '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
       '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
       'https://bscscan.com'
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

-- 3. Minimal BSC whitelist seed (hints only) — 18-DECIMAL STABLES, WITH LOGOS ----------------
INSERT INTO tokens (address, symbol, name, decimals, logo_uri, chain_id, is_active, source, liquidity_usd)
VALUES
  ('0x55d398326f99059fF775485246999027B3197955', 'USDT', 'Tether USD',          18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0x55d398326f99059fF775485246999027B3197955/logo.png', 56, true, 'seed', 50000000),
  ('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC', 'USD Coin',            18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d/logo.png', 56, true, 'seed', 50000000),
  ('0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', 'DAI',  'Dai Stablecoin',      18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3/logo.png', 56, true, 'seed', 50000000),
  ('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'WBNB', 'Wrapped BNB',         18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png',                                             56, true, 'seed', 50000000),
  ('0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 'BTCB', 'Binance-Peg BTCB',    18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c/logo.png', 56, true, 'seed', 50000000),
  ('0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 'ETH',  'Binance-Peg Ethereum',18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',                                               56, true, 'seed', 50000000)
ON CONFLICT (chain_id, address) DO UPDATE SET
  symbol = EXCLUDED.symbol,
  name = EXCLUDED.name,
  decimals = EXCLUDED.decimals,
  logo_uri = EXCLUDED.logo_uri,
  is_active = EXCLUDED.is_active,
  liquidity_usd = EXCLUDED.liquidity_usd,
  last_checked = now();

-- 4. Ethereum seed rows shipped without logo_uri — fill only where still NULL ----------------
UPDATE tokens SET logo_uri = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png'
  WHERE chain_id = 1 AND lower(address) = lower('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') AND logo_uri IS NULL;
UPDATE tokens SET logo_uri = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png'
  WHERE chain_id = 1 AND lower(address) = lower('0xdAC17F958D2ee523a2206206994597C13D831ec7') AND logo_uri IS NULL;
UPDATE tokens SET logo_uri = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png'
  WHERE chain_id = 1 AND lower(address) = lower('0x6B175474E89094C44Da98b954EedeAC495271d0F') AND logo_uri IS NULL;
UPDATE tokens SET logo_uri = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png'
  WHERE chain_id = 1 AND lower(address) = lower('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2') AND logo_uri IS NULL;
UPDATE tokens SET logo_uri = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png'
  WHERE chain_id = 1 AND lower(address) = lower('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599') AND logo_uri IS NULL;

COMMIT;
