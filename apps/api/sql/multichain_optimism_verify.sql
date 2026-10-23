-- Read-only post-migration verification. Expect one Optimism registry row.
SELECT chain_id, chain_slug, name, wrapped_token_address, explorer_url
FROM public.chain_registry WHERE chain_id = 10;

-- Expect all eight seeded addresses with the specified decimals, active and with a logo.
WITH expected(address, decimals) AS (VALUES
  ('0x0b2c639c533813f4aa9d7837caf62653d097ff85', 6),
  ('0x4200000000000000000000000000000000000006', 18),
  ('0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', 6),
  ('0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', 18),
  ('0x68f180fcce6836688e9084f035309e29bf0a2095', 8),
  ('0x4200000000000000000000000000000000000042', 18),
  ('0x7f5c764cbc14f9669b88837ca1490cca17c31607', 6),
  ('0x01bff41798a0bcf287b996046ca68b395dbc1071', 6)
)
SELECT e.address, t.symbol, t.decimals, t.is_active, t.logo_uri IS NOT NULL AS has_logo,
       (t.decimals = e.decimals AND t.is_active AND t.logo_uri IS NOT NULL) AS passed
FROM expected e LEFT JOIN public.tokens t ON t.chain_id = 10 AND lower(t.address) = e.address
ORDER BY e.address;

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'tokens'
  AND indexname = 'idx_tokens_chain_address_unique';

-- Other chain rows remain independently addressable despite the shared WETH/DAI addresses.
SELECT chain_id, symbol, address FROM public.tokens
WHERE chain_id IN (10, 8453) AND lower(address) = '0x4200000000000000000000000000000000000006'
ORDER BY chain_id;
