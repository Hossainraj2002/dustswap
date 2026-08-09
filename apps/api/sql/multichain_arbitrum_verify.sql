-- Verify whether multichain_arbitrum.sql actually landed on the Railway DB.
-- Read-only. Safe to run any time. Run all four blocks and compare against "EXPECTED".

-- 1. chain_registry row -----------------------------------------------------
-- EXPECTED: exactly 1 row — 42161 | arbitrum | Arbitrum One | 0x82aF…Bab1 | https://arbiscan.io
SELECT chain_id, chain_slug, name, wrapped_token_address, explorer_url
FROM chain_registry
WHERE chain_id = 42161;

-- 2. seeded tokens ----------------------------------------------------------
-- EXPECTED: 7 rows, every one with logo_uri NOT NULL and is_active = true.
--   USDC 6 | WETH 18 | USD₮0 6 | ARB 18 | WBTC 8 | DAI 18 | USDC.e 6
SELECT symbol, decimals, is_active, (logo_uri IS NOT NULL) AS has_logo, address
FROM tokens
WHERE chain_id = 42161
ORDER BY symbol;

-- 3. quick pass/fail --------------------------------------------------------
-- EXPECTED: registry_rows = 1, token_rows = 7, tokens_missing_logo = 0
SELECT
  (SELECT count(*) FROM chain_registry WHERE chain_id = 42161)                    AS registry_rows,
  (SELECT count(*) FROM tokens WHERE chain_id = 42161)                            AS token_rows,
  (SELECT count(*) FROM tokens WHERE chain_id = 42161 AND logo_uri IS NULL)       AS tokens_missing_logo;

-- 4. the (chain_id, address) unique index the migration depends on -----------
-- EXPECTED: 1 row named idx_tokens_chain_address_unique.
-- If this is MISSING, the ON CONFLICT (chain_id, address) upsert in the migration
-- would have errored and NOTHING above will exist — re-run multichain_arbitrum.sql.
SELECT indexname FROM pg_indexes
WHERE tablename = 'tokens' AND indexname = 'idx_tokens_chain_address_unique';

-- ── If block 3 returns 0 / 0 / 0, the migration has NOT been applied. ──
-- Apply it with:  psql "$DATABASE_PUBLIC_URL" -f apps/api/sql/multichain_arbitrum.sql
-- It is idempotent, so re-running is harmless.
