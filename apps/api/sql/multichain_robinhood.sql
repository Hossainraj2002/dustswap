-- Multichain expansion: Robinhood Chain (chainId 4663) support for DustSweep.
--
-- ADDITIVE + IDEMPOTENT. Safe to run multiple times. Does NOT touch Base (8453), Ethereum (1)
-- or BSC (56) data. Apply BEFORE flipping DUST_SWEEP_ENABLED_CHAIN_IDS=8453,1,56,4663.
--
-- What it does:
--   1. Ensures the (chain_id, address) uniqueness from multichain_ethereum.sql is in place
--      (no-op when that migration already ran).
--   2. Registers Robinhood Chain in chain_registry.
--   3. Seeds a minimal Robinhood whitelist WITH logo_uri (lesson from the Ethereum seed).
--
-- Robinhood gotchas encoded here:
--   - NO USDC/USDT/DAI exist on this chain. The USD stable is USDG ("Global Dollar", Paxos),
--     6 DECIMALS — the canonical one is 0x5fc5…d168 (36k holders, $118M/day). The OTHER
--     USDG-labeled token 0x0A3B…954F is a 2-holder test deploy and is deliberately NOT seeded.
--   - Native gas token IS ETH; wrapped native is literally WETH (18 decimals).
--
-- All addresses verified live 2026-07-26 via eth_getCode + decimals()/symbol() eth_calls on
-- rpc.mainnet.chain.robinhood.com (chainId 0x1237) — never explorer labels.

BEGIN;

-- 1. tokens uniqueness: (chain_id, address) ------------------------------------------------
-- Same defensive block as multichain_ethereum.sql / multichain_bsc.sql; harmless if already ran.
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

-- 2. chain_registry: Robinhood Chain --------------------------------------------------------
INSERT INTO chain_registry (chain_id, chain_slug, name, native_token_id, wrapped_token_address, explorer_url)
SELECT 4663,
       'robinhood',
       'Robinhood',
       '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
       '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
       'https://robinhoodchain.blockscout.com'
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

-- 3. Minimal Robinhood whitelist seed (hints only) — USDG IS 6 DECIMALS, WITH LOGOS ----------
-- Decimals verified on-chain 2026-07-26: USDG=6, WETH=18, USDe=18, LINK=18.
INSERT INTO tokens (address, symbol, name, decimals, logo_uri, chain_id, is_active, source, liquidity_usd)
VALUES
  ('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'USDG', 'Global Dollar',   6, 'https://assets.coingecko.com/coins/images/51281/standard/GDN_USDG_Token_200x200.png',                                          4663, true, 'seed', 50000000),
  ('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 'WETH', 'Wrapped Ether',  18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',                                4663, true, 'seed', 50000000),
  ('0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', 'USDe', 'Ethena USDe',    18, 'https://token-icons.llamao.fi/icons/tokens/4663/0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34?h=48&w=48',                          4663, true, 'seed', 1000000),
  ('0x492641F648a4986844848E0beFE66D14817bCE34', 'LINK', 'ChainLink Token',18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x514910771AF9Ca656af840dff83E8264EcF986CA/logo.png', 4663, true, 'seed', 1000000)
ON CONFLICT (chain_id, address) DO UPDATE SET
  symbol = EXCLUDED.symbol,
  name = EXCLUDED.name,
  decimals = EXCLUDED.decimals,
  logo_uri = EXCLUDED.logo_uri,
  is_active = EXCLUDED.is_active,
  liquidity_usd = EXCLUDED.liquidity_usd,
  last_checked = now();

COMMIT;
