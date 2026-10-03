import type { Pool } from "pg";
import {
  type Address,
  type PublicClient,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  hexToBigInt,
  keccak256,
  zeroAddress,
} from "viem";

import type { Deployment } from "../deployment";
import { COIN_SUPPLY, DEAD_ADDRESS } from "../../shared/core/constants";
import { buybackBurnVaultAbi, feeVaultAbi, floorVaultAbi, holderRewardDistributorAbi, memeFunHookAbi } from "../../shared/abis";

/**
 * Compares what the indexer wrote with what the contracts say, at the chain's latest block. Used by
 * `pnpm verify-index` during development and by the e2e suite. Returns every mismatch found;
 * an empty list means the index agrees with the chain.
 */

const POOLS_SLOT = 6n;
const extsloadAbi = [
  { type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ name: "", type: "bytes32" }] },
] as const;
const erc6909BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface TruthReport {
  coins: number;
  checks: number;
  failures: string[];
}

interface CoinRow {
  address: string;
  pool_id: `0x${string}`;
  creator: string;
  quote: string;
  fee_bps: number;
  sqrt_price_x_96: string;
  pool_quote: string;
  pool_coins: string;
  burned: string;
  trades: number;
  volume_quote: string;
  price_usd_e_18: string;
  holders: number;
  creator_earned: string;
  creator_claimed: string;
  destination_earned: string;
  destination_pulled: string;
  buyback_spent: string;
  buyback_burned: string;
  floor_quote: string;
  floor_near_tick: number | null;
  mode: number;
}

export async function verifyIndexAgainstChain(input: {
  pool: Pool;
  schema: string;
  client: PublicClient;
  deployment: Deployment;
}): Promise<TruthReport> {
  const { pool, client, deployment: d } = input;
  const schema = input.schema.replace(/"/g, "");
  const q = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql.replaceAll("$S", `"${schema}"`), params)).rows as T[];
  const failures: string[] = [];
  let checks = 0;
  const expect = (ok: boolean, message: string) => {
    checks += 1;
    if (!ok) failures.push(message);
  };
  const eq = (label: string, indexed: bigint | number | string | null, chain: bigint | number | string | null) =>
    expect(String(indexed) === String(chain), `${label}: indexed ${indexed}, chain ${chain}`);

  const coins = await q<CoinRow>(`SELECT * FROM $S.coin WHERE launched = true ORDER BY address`);
  for (const c of coins) {
    const coin = getAddress(c.address);
    const tag = `${coin.slice(0, 10)}`;

    // Pool price, straight from PoolManager storage (StateLibrary.getSlot0).
    const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [c.pool_id, POOLS_SLOT]));
    const slot0 = await client.readContract({ address: d.poolManager, abi: extsloadAbi, functionName: "extsload", args: [slot] });
    const sqrtPrice = hexToBigInt(slot0) & ((1n << 160n) - 1n);
    eq(`${tag} sqrtPriceX96`, c.sqrt_price_x_96, sqrtPrice);

    // Balances: every indexed balance equals balanceOf, and all of them sum to the supply.
    const balances = await q<{ account: string; amount: string; excluded: boolean }>(
      `SELECT account, amount, excluded FROM $S.balance WHERE coin = $1`,
      [c.address],
    );
    let sum = 0n;
    let holders = 0;
    for (const b of balances) {
      const chainBalance = await client.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(b.account)] });
      eq(`${tag} balance ${b.account.slice(0, 10)}`, b.amount, chainBalance);
      sum += BigInt(b.amount);
      if (!b.excluded && BigInt(b.amount) > 0n) holders += 1;
    }
    eq(`${tag} sum of balances`, sum, COIN_SUPPLY);
    eq(`${tag} holders`, c.holders, holders);
    eq(`${tag} burned`, c.burned, await client.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [DEAD_ADDRESS] }));
    eq(`${tag} pool coins`, c.pool_coins, await client.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [d.poolManager] }));

    // Terms that can change after launch.
    const config = await client.readContract({ address: d.hook, abi: memeFunHookAbi, functionName: "configOf", args: [coin] });
    eq(`${tag} feeBps`, c.fee_bps, config.feeBps);
    eq(`${tag} creator`, c.creator, (await client.readContract({ address: d.hook, abi: memeFunHookAbi, functionName: "creatorOf", args: [coin] })).toLowerCase());

    // FeeVault ledgers, derived from Trade events by the same split the vault applies.
    eq(
      `${tag} creator pending`,
      BigInt(c.creator_earned) - BigInt(c.creator_claimed),
      await client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "creatorPending", args: [coin] }),
    );
    eq(
      `${tag} destination pending`,
      BigInt(c.destination_earned) - BigInt(c.destination_pulled),
      await client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "destinationPending", args: [coin] }),
    );

    if (c.mode === 1) {
      eq(`${tag} buyback spent`, c.buyback_spent, await client.readContract({ address: d.buybackBurnVault, abi: buybackBurnVaultAbi, functionName: "totalSpent", args: [coin] }));
      eq(`${tag} buyback burned`, c.buyback_burned, await client.readContract({ address: d.buybackBurnVault, abi: buybackBurnVaultAbi, functionName: "totalBurned", args: [coin] }));
    }
    if (c.mode === 3) {
      eq(`${tag} floor quote`, c.floor_quote, await client.readContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "totalFloored", args: [coin] }));
      const hasFloor = await client.readContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "hasFloor", args: [coin] });
      const nearTick = hasFloor ? await client.readContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "floorNearTick", args: [coin] }) : null;
      eq(`${tag} floor near tick`, c.floor_near_tick, nearTick);
    }

    // Candles: every interval accounts for every trade, and the latest close is the coin price.
    const candles = await q<{ interval: number; trades: string; volume: string; last_close: string }>(
      `SELECT interval, SUM(trades)::text AS trades, SUM(volume_quote)::text AS volume,
              (ARRAY_AGG(close_usd_e_18 ORDER BY bucket DESC))[1]::text AS last_close
         FROM $S.candle WHERE coin = $1 GROUP BY interval ORDER BY interval`,
      [c.address],
    );
    expect(candles.length === (c.trades > 0 ? 6 : 0), `${tag} candle intervals: ${candles.length}`);
    for (const candle of candles) {
      eq(`${tag} candles(${candle.interval}) trades`, candle.trades, c.trades);
      eq(`${tag} candles(${candle.interval}) volume`, candle.volume, c.volume_quote);
      eq(`${tag} candles(${candle.interval}) close`, candle.last_close, c.price_usd_e_18);
    }
  }

  // Referral and platform ledgers.
  const referrals = await q<{ referrer: string; currency: string; earned: string; claimed: string }>(`SELECT * FROM $S.referral_ledger`);
  for (const r of referrals) {
    const pending = await client.readContract({
      address: d.feeVault,
      abi: feeVaultAbi,
      functionName: "referralPending",
      args: [getAddress(r.referrer), getAddress(r.currency)],
    });
    eq(`referral ${r.referrer.slice(0, 10)}/${r.currency.slice(0, 8)}`, BigInt(r.earned) - BigInt(r.claimed), pending);
  }
  const platform = await q<{ currency: string; earned: string; claimed: string }>(`SELECT * FROM $S.platform_ledger`);
  for (const p of platform) {
    const pending = await client.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "platformPending", args: [getAddress(p.currency)] });
    eq(`platform ${p.currency.slice(0, 8)}`, BigInt(p.earned) - BigInt(p.claimed), pending);
  }

  // Conservation per pair asset: what the PoolManager holds equals the indexed pool quote of every
  // coin on that asset plus every ERC-6909 claim on it (fee ledgers and module balances).
  const perQuote = await q<{ quote: string; pool_quote: string }>(
    `SELECT quote, SUM(pool_quote)::text AS pool_quote FROM $S.coin WHERE launched = true GROUP BY quote`,
  );
  const claimHolders = [d.feeVault, d.buybackBurnVault, d.floorVault, d.holderRewardDistributor];
  for (const row of perQuote) {
    const currency = getAddress(row.quote);
    const held =
      currency === zeroAddress
        ? await client.getBalance({ address: d.poolManager })
        : await client.readContract({ address: currency, abi: erc20Abi, functionName: "balanceOf", args: [d.poolManager] });
    let claims = 0n;
    for (const holder of claimHolders) {
      claims += await client.readContract({ address: d.poolManager, abi: erc6909BalanceAbi, functionName: "balanceOf", args: [holder as Address, BigInt(currency)] });
    }
    eq(`conservation ${row.quote.slice(0, 8)} (pool quote + claims = PoolManager balance)`, BigInt(row.pool_quote) + claims, held);
  }

  // Holder-reward epochs, if any were published.
  const lastEpoch = await client.readContract({ address: d.holderRewardDistributor, abi: holderRewardDistributorAbi, functionName: "lastEpoch" });
  const indexedEpochs = await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM $S.epoch`);
  eq("epochs published", indexedEpochs[0]?.n ?? "0", lastEpoch);

  return { coins: coins.length, checks, failures };
}
