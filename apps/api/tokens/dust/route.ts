import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient,
  http,
  erc20Abi,
  formatUnits,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
} from 'viem';
import { base } from 'viem/chains';

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';

const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { timeout: 20_000 }),
});

// ─── Uniswap V3 on Base ───────────────────────────────────────────────────────

const QUOTER_ADDRESS: Address = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const WETH_ADDRESS:   Address = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS:   Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FEE_TIERS = [500, 3000, 10000, 100] as const;

const QUOTER_ABI = [
  {
    inputs: [{ components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ], name: 'params', type: 'tuple' }],
    name: 'quoteExactInputSingle',
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ─── Known Tokens ─────────────────────────────────────────────────────────────

const KNOWN_TOKENS: { address: Address; symbol: string; name: string; decimals: number; logoURI?: string }[] = [
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC',    name: 'USD Coin',                     decimals: 6,  logoURI: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png' },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH',    name: 'Wrapped Ether',                decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/2518/small/weth.png' },
  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI',     name: 'Dai Stablecoin',              decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png' },
  { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC',   name: 'USD Base Coin',               decimals: 6  },
  { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH',   name: 'Coinbase Wrapped Staked ETH', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/27008/small/cbeth.png' },
  { address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', symbol: 'rETH',    name: 'Rocket Pool ETH',             decimals: 18 },
  { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', symbol: 'wstETH',  name: 'Wrapped stETH',               decimals: 18 },
  { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO',    name: 'Aerodrome Finance',           decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/31745/small/token.png' },
  { address: '0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe', symbol: 'HIGHER',  name: 'Higher',                      decimals: 18 },
  { address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', symbol: 'TOSHI',   name: 'Toshi',                       decimals: 18 },
  { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT',   name: 'Brett',                       decimals: 18 },
  { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN',   name: 'Degen',                       decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/34515/small/android-chrome-192x192.png' },
  { address: '0xfA980cEd6895AC314E7dE34Ef1bFAE90a5AdD21b', symbol: 'PRIME',   name: 'Echelon Prime',               decimals: 18 },
  { address: '0x3C281A39944a2319aA653D81Cfd93Ca10983D234', symbol: 'MORPHO',  name: 'Morpho',                      decimals: 18 },
  { address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', symbol: 'VIRTUAL', name: 'Virtual Protocol',            decimals: 18 },
  { address: '0x22e6966B799c4D5B13BE962E1D117b56327FDa66', symbol: 'MOG',     name: 'Mog Coin',                    decimals: 18 },
  { address: '0xA88594D404727625A9437C3f886C7643872296AE', symbol: 'WELL',    name: 'Moonwell',                    decimals: 18 },
  { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC',   name: 'Coinbase Wrapped BTC',        decimals: 8  },
  { address: '0x6921B130D297cc43754afba22e5EAc0FBf8Db75b', symbol: 'doginme', name: 'doginme',                     decimals: 18 },
  { address: '0x7D49a065D17d6d4a55dc13649901fdBB98B2AFBA', symbol: 'SUSHI',   name: 'SushiSwap',                   decimals: 18 },
  { address: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b', symbol: 'tBTC',    name: 'tBTC v2',                     decimals: 18 },
  { address: '0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415', symbol: 'CRV',     name: 'Curve DAO',                   decimals: 18 },
  { address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', symbol: 'EURC',    name: 'Euro Coin',                   decimals: 6  },
  { address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', symbol: 'weETH',   name: 'Wrapped eETH',                decimals: 18 },
  { address: '0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71', symbol: 'MOG',     name: 'Mog Coin (old)',              decimals: 18 },
  { address: '0x628a3b2E302c7e896AcC432D2d0dD22B6cb9bc88', symbol: 'ZORA',    name: 'Zora',                        decimals: 18 },
  { address: '0xCfA3Ef56d303AE4fAabA0592388F19d7C3399FB4', symbol: 'eUSD',    name: 'Electronic Dollar',           decimals: 18 },
  { address: '0x9a26F5433671751C3276a065f57e5a02D2817973', symbol: 'KWENTA',  name: 'Kwenta',                      decimals: 18 },
];

// ─── Timeout helper ───────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// ─── Uniswap Quoter helpers ───────────────────────────────────────────────────

async function tryQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<bigint | null> {
  try {
    const data = encodeFunctionData({
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    const result = await publicClient.call({ to: QUOTER_ADDRESS, data });
    if (!result.data) return null;
    const decoded = decodeFunctionResult({
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      data: result.data,
    });
    const out = decoded[0];
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

/**
 * FIX 2 — Real liquidity detection via Uniswap Quoter.
 * Replaces the old hardcoded TOKENS_WITH_LIQUIDITY set.
 * Uses a small test amount (0.001 of the token) so we don't need actual balance.
 * Returns hasLiquidity + a USD price derived from the quote.
 */
async function checkLiquidityAndPrice(
  tokenAddress: Address,
  decimals: number,
): Promise<{ hasLiquidity: boolean; quoterPriceUsd: number }> {
  // Test amount = 0.001 of the token
  const testAmount = BigInt(10) ** BigInt(Math.max(0, decimals - 3));

  // Direct: token → USDC
  for (const fee of FEE_TIERS) {
    const usdcOut = await tryQuote(tokenAddress, USDC_ADDRESS, testAmount, fee);
    if (usdcOut !== null) {
      const priceUsd = (Number(usdcOut) / 1e6) / (Number(testAmount) / 10 ** decimals);
      return { hasLiquidity: true, quoterPriceUsd: priceUsd };
    }
  }

  // Two-hop: token → WETH → USDC
  for (const fee of FEE_TIERS) {
    const wethOut = await tryQuote(tokenAddress, WETH_ADDRESS, testAmount, fee);
    if (!wethOut || wethOut === 0n) continue;

    const usdcOut = await tryQuote(WETH_ADDRESS, USDC_ADDRESS, wethOut, 500);
    if (usdcOut !== null && usdcOut > 0n) {
      const priceUsd = (Number(usdcOut) / 1e6) / (Number(testAmount) / 10 ** decimals);
      return { hasLiquidity: true, quoterPriceUsd: priceUsd };
    }
  }

  return { hasLiquidity: false, quoterPriceUsd: 0 };
}

// ─── External price fetching ──────────────────────────────────────────────────

async function fetchExternalPrices(addresses: Address[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1.0,
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 1.0,
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 1.0,
    '0xcfa3ef56d303ae4faaba0592388f19d7c3399fb4': 1.0,
  };

  // CoinGecko
  try {
    const addrList = addresses.map((a) => a.toLowerCase()).join(',');
    const resp = await withTimeout(
      fetch(`https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${addrList}&vs_currencies=usd`,
        { headers: { Accept: 'application/json' } }),
      5000,
    );
    if (resp?.ok) {
      const data = (await resp.json()) as Record<string, { usd?: number }>;
      for (const [addr, info] of Object.entries(data)) {
        if (info.usd && info.usd > 0) prices[addr.toLowerCase()] = info.usd;
      }
    }
  } catch { /* ignore */ }

  // Oku fallback for missing prices
  const missing = addresses.filter((a) => !prices[a.toLowerCase()]);
  if (missing.length > 0) {
    try {
      const resp = await withTimeout(
        fetch('https://omni.icarus.tools/base/cush/analyticsTokenList', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ params: { tokens: missing.map((a) => a.toLowerCase()) } }),
        }),
        5000,
      );
      if (resp?.ok) {
        const data = (await resp.json()) as { tokens?: { address?: string; price_usd?: string }[] };
        for (const t of data.tokens ?? []) {
          if (t.address && t.price_usd) {
            const p = Number(t.price_usd);
            if (p > 0) prices[t.address.toLowerCase()] = p;
          }
        }
      }
    } catch { /* ignore */ }
  }

  return prices;
}

// ─── Alchemy token discovery ──────────────────────────────────────────────────

async function discoverTokensFromAlchemy(walletAddress: Address): Promise<Address[]> {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) return [];
  try {
    const resp = await withTimeout(
      fetch(`https://base-mainnet.g.alchemy.com/v2/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params: [walletAddress, 'erc20'] }),
      }),
      10_000,
    );
    if (!resp?.ok) return [];
    const data = (await resp.json()) as {
      result?: { tokenBalances?: { contractAddress: string; tokenBalance?: string }[] };
    };
    return (data.result?.tokenBalances ?? [])
      .filter((tb) => BigInt(tb.tokenBalance ?? '0') > 0n)
      .map((tb) => tb.contractAddress as Address);
  } catch {
    return [];
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address') as Address | null;
  const threshold = Number(searchParams.get('threshold') || '5');

  if (!address) {
    return NextResponse.json({ error: 'address parameter required' }, { status: 400 });
  }

  try {
    // 1. Collect all addresses to scan
    const tokenSet = new Set<string>(KNOWN_TOKENS.map((t) => t.address.toLowerCase()));
    const alchemyTokens = await discoverTokensFromAlchemy(address);
    for (const addr of alchemyTokens) tokenSet.add(addr.toLowerCase());
    const allAddresses = Array.from(tokenSet) as Address[];

    // 2. Batch balances
    const balanceResults = await publicClient.multicall({
      contracts: allAddresses.map((a) => ({
        address: a, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address] as const,
      })),
      allowFailure: true,
    });

    // 3. Metadata for unknown tokens
    const knownMap = new Map(KNOWN_TOKENS.map((t) => [t.address.toLowerCase(), t]));
    const unknownAddrs = allAddresses.filter((a) => !knownMap.has(a.toLowerCase()));
    let metadataResults: { status: string; result?: unknown }[] = [];
    if (unknownAddrs.length > 0) {
      const metaCalls: { address: Address; abi: typeof erc20Abi; functionName: 'name' | 'symbol' | 'decimals' }[] = [];
      for (const addr of unknownAddrs) {
        metaCalls.push(
          { address: addr, abi: erc20Abi, functionName: 'name' },
          { address: addr, abi: erc20Abi, functionName: 'symbol' },
          { address: addr, abi: erc20Abi, functionName: 'decimals' },
        );
      }
      metadataResults = await publicClient.multicall({ contracts: metaCalls, allowFailure: true });
    }

    const discoveredMeta = new Map<string, { name: string; symbol: string; decimals: number }>();
    for (let i = 0; i < unknownAddrs.length; i++) {
      const n = metadataResults[i * 3], s = metadataResults[i * 3 + 1], d = metadataResults[i * 3 + 2];
      if (n?.status === 'success' && s?.status === 'success' && d?.status === 'success') {
        discoveredMeta.set(unknownAddrs[i].toLowerCase(), {
          name: n.result as string, symbol: s.result as string, decimals: Number(d.result),
        });
      }
    }

    // 4. Collect non-zero balance tokens
    const nonZero: { address: Address; balance: bigint; name: string; symbol: string; decimals: number; logoURI?: string }[] = [];
    for (let i = 0; i < allAddresses.length; i++) {
      const res = balanceResults[i];
      if (res.status !== 'success') continue;
      const balance = res.result as bigint;
      if (balance === 0n) continue;
      const addrL = allAddresses[i].toLowerCase();
      const meta = knownMap.get(addrL) ?? discoveredMeta.get(addrL);
      if (!meta) continue;
      nonZero.push({ address: allAddresses[i], balance, ...meta });
    }

    if (nonZero.length === 0) {
      return NextResponse.json({ dustTokens: [], noLiquidityTokens: [] });
    }

    // 5. External prices (batch)
    const extPrices = await fetchExternalPrices(nonZero.map((t) => t.address));

    // 6. Liquidity check via Uniswap Quoter (all in parallel, 4s timeout each)
    //    FIX 1 + FIX 2: replaces hardcoded TOKENS_WITH_LIQUIDITY set
    const checks = await Promise.all(
      nonZero.map(async (token) => {
        const extPrice = extPrices[token.address.toLowerCase()] ?? 0;
        const valueUsd = Number(formatUnits(token.balance, token.decimals)) * extPrice;

        // Skip Quoter for tokens comfortably above threshold — saves RPC calls
        if (valueUsd > threshold * 3 && extPrice > 0) {
          return { token, hasLiquidity: true, priceUsd: extPrice };
        }

        const res = await withTimeout(checkLiquidityAndPrice(token.address, token.decimals), 4000);
        const hasLiquidity = res?.hasLiquidity ?? false;
        const priceUsd = extPrice > 0 ? extPrice : (res?.quoterPriceUsd ?? 0);
        return { token, hasLiquidity, priceUsd };
      }),
    );

    // 7. Categorise
    const dustTokens: {
      address: Address; name: string; symbol: string; decimals: number;
      balance: string; balanceFormatted: string; usdValue: number;
      logoURI?: string; hasLiquidity: boolean;
    }[] = [];
    const noLiquidityTokens: typeof dustTokens = [];

    for (const { token, hasLiquidity, priceUsd } of checks) {
      const balanceFloat = Number(formatUnits(token.balance, token.decimals));
      const usdValue = balanceFloat * priceUsd;

      // Skip if comfortably above threshold (it's not dust)
      if (usdValue > threshold && priceUsd > 0) continue;

      const entry = {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        balance: token.balance.toString(),
        balanceFormatted: formatUnits(token.balance, token.decimals),
        usdValue: Math.round(usdValue * 10000) / 10000,
        logoURI: token.logoURI,
        hasLiquidity,
      };

      if (hasLiquidity) {
        dustTokens.push(entry);
      } else {
        noLiquidityTokens.push(entry);
      }
    }

    dustTokens.sort((a, b) => b.usdValue - a.usdValue);
    noLiquidityTokens.sort((a, b) => b.usdValue - a.usdValue);

    return NextResponse.json({ dustTokens, noLiquidityTokens });
  } catch (err) {
    console.error('[dust/route] Error:', err);
    return NextResponse.json({ error: 'Failed to fetch tokens', message: String(err) }, { status: 500 });
  }
}
