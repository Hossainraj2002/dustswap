-- Final write-time guard for swap USD volume.
-- App code should sanitize suspicious quotes before insert; this trigger prevents
-- any future code path/API bug from writing high unanchored USD volume.

CREATE OR REPLACE FUNCTION swap_volume_is_trusted_anchor(
  p_chain_id INTEGER,
  p_token_address TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  WITH token AS (
    SELECT lower(coalesce(p_token_address, '')) AS address
  )
  SELECT CASE
    WHEN address IN (
      '0x0000000000000000000000000000000000000000',
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    ) THEN TRUE
    WHEN p_chain_id = 8453 AND address IN (
      -- Base: WETH, stables, BTC wrappers, ETH staking wrappers.
      '0x4200000000000000000000000000000000000006',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
      '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
      '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
      '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
      '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
      '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
      '0x236aa50979d5f3de3bd1eeb40e81137f22ab794b',
      '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22',
      '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c',
      '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a',
      '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452'
    ) THEN TRUE
    WHEN p_chain_id = 1 AND address IN (
      -- Ethereum: WETH and core stable/BTC anchors.
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      '0xdac17f958d2ee523a2206206994597c13d831ec7',
      '0x6b175474e89094c44da98b954eedeac495271d0f',
      '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'
    ) THEN TRUE
    WHEN p_chain_id = 42161 AND address IN (
      -- Arbitrum: WETH and core stable/BTC anchors.
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
      '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f'
    ) THEN TRUE
    WHEN p_chain_id = 10 AND address IN (
      -- Optimism: WETH and core stable anchors.
      '0x4200000000000000000000000000000000000006',
      '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
      '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1'
    ) THEN TRUE
    WHEN p_chain_id = 137 AND address IN (
      -- Polygon: WMATIC and core stable/BTC anchors.
      '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
      '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
      '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
      '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6'
    ) THEN TRUE
    WHEN p_chain_id = 56 AND address IN (
      -- BNB Chain: WBNB and core stable/BTC anchors.
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      '0x55d398326f99059ff775485246999027b3197955',
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3',
      '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c'
    ) THEN TRUE
    WHEN p_chain_id = 43114 AND address IN (
      -- Avalanche: WAVAX and core stable/BTC anchors.
      '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
      '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664',
      '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
      '0xc7198437980c041c805a1edcba50c1ce5db95118',
      '0xd586e7f844cea2f87f50152665bcbc2c279d8d70',
      '0x152b9d0fdc40c096757f570a51e494bd4b943e50'
    ) THEN TRUE
    ELSE FALSE
  END
  FROM token;
$$;

CREATE OR REPLACE FUNCTION enforce_swap_volume_write_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.amount_usd IS NULL OR NEW.amount_usd < 0 THEN
    RAISE EXCEPTION 'swap amount_usd must be non-negative for tx %', NEW.tx_hash
      USING ERRCODE = '22023';
  END IF;

  IF NEW.amount_usd > 1000
     AND NOT swap_volume_is_trusted_anchor(NEW.chain_id, NEW.src_token_address)
     AND NOT swap_volume_is_trusted_anchor(NEW.chain_id, NEW.dst_token_address) THEN
    RAISE EXCEPTION
      'unsafe high swap USD volume rejected for tx % on chain %: amount_usd %, src %, dst %',
      NEW.tx_hash,
      NEW.chain_id,
      NEW.amount_usd,
      NEW.src_token_address,
      NEW.dst_token_address
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_swap_volume_write_guard ON swap_transactions;

CREATE TRIGGER trg_swap_volume_write_guard
  BEFORE INSERT OR UPDATE OF amount_usd, src_token_address, dst_token_address, chain_id
  ON swap_transactions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_swap_volume_write_guard();
