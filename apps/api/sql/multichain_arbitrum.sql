-- Multichain expansion: Arbitrum One (chainId 42161) support for DustSweep.
--
-- ADDITIVE + IDEMPOTENT. Safe to run multiple times. Does NOT touch Base (8453), Ethereum (1),
-- BSC (56) or Robinhood (4663) data. Apply BEFORE flipping
-- DUST_SWEEP_ENABLED_CHAIN_IDS=8453,1,56,4663,42161.
--
-- What it does:
--   1. Ensures the (chain_id, address) uniqueness from multichain_ethereum.sql is in place
--      (no-op when that migration already ran).
--   2. Registers Arbitrum One in chain_registry.
--   3. Seeds a minimal Arbitrum whitelist WITH logo_uri (lesson from the Ethereum seed).
--
-- Arbitrum gotchas encoded here:
--   - Native gas token IS ETH; wrapped native is literally WETH (18 decimals) — no WBNB-style
--     rename anywhere, same as Ethereum/Robinhood.
--   - The default USD stable is NATIVE Circle USDC 0xaf88…5831 (6 dec). The legacy BRIDGED
--     USDC.e 0xFF97…5CC8 (6 dec) is ALSO seeded — it is a first-class sweepable token, it is just
--     never a default output.
--   - 0xFd086bC7…FCbb9 now reports symbol() = 'USD₮0' (Tether migrated Arbitrum USDT to the USDT0
--     standard at the SAME address; still 6 decimals). Seeded with the ON-CHAIN symbol so the seed
--     never disagrees with what readErc20Metadata reads live.
--   - The whitelist is a HINT source, not a visibility gate — discovery surfaces every non-zero
--     balance regardless. These rows exist to give the top tokens good metadata + logos on the
--     first paint.
--
-- All addresses + decimals verified live 2026-08-07 via eth_getCode / eth_call (symbol(),
-- decimals()) on chainId 42161 — never explorer labels alone.

BEGIN;

-- 1. tokens uniqueness: (chain_id, address) ------------------------------------------------
-- Same defensive block as multichain_ethereum.sql / multichain_bsc.sql / multichain_robinhood.sql;
-- harmless if already ran.
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

-- 2. chain_registry: Arbitrum One -----------------------------------------------------------
INSERT INTO chain_registry (chain_id, chain_slug, name, native_token_id, wrapped_token_address, explorer_url)
SELECT 42161,
       'arbitrum',
       'Arbitrum One',
       '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
       '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
       'https://arbiscan.io'
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

-- 3. Minimal Arbitrum whitelist seed (hints only) — WITH LOGOS -------------------------------
-- Decimals verified on-chain 2026-08-07: USDC=6, WETH=18, USD₮0=6, DAI=18, ARB=18, WBTC=8,
-- USDC.e=6.
INSERT INTO tokens (address, symbol, name, decimals, logo_uri, chain_id, is_active, source, liquidity_usd)
VALUES
  ('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC',  'USD Coin',                   6, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png', 42161, true, 'seed', 50000000),
  ('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH',  'Wrapped Ether',             18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',                                                    42161, true, 'seed', 50000000),
  ('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USD₮0', 'USDT0',                      6, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png', 42161, true, 'seed', 50000000),
  ('0x912CE59144191C1204E64559FE8253a0e49E6548', 'ARB',   'Arbitrum',                  18, 'https://token-icons.llamao.fi/icons/tokens/42161/0x912ce59144191c1204e64559fe8253a0e49e6548?h=48&w=48',                                            42161, true, 'seed', 10000000),
  ('0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 'WBTC',  'Wrapped BTC',                8, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png', 42161, true, 'seed', 10000000),
  ('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI',   'Dai Stablecoin',            18, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png', 42161, true, 'seed', 1000000),
  ('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 'USDC.e','Bridged USDC (Arbitrum)',    6, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png', 42161, true, 'seed', 1000000)
ON CONFLICT (chain_id, address) DO UPDATE SET
  symbol = EXCLUDED.symbol,
  name = EXCLUDED.name,
  decimals = EXCLUDED.decimals,
  logo_uri = EXCLUDED.logo_uri,
  is_active = EXCLUDED.is_active,
  liquidity_usd = EXCLUDED.liquidity_usd,
  last_checked = now();

COMMIT;
