import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, erc20Abi, formatUnits, type Address } from 'viem';
import { base } from 'viem/chains';

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';

const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// Well-known Base tokens to scan for dust
// You can expand this list — these are the most common tokens on Base
const KNOWN_TOKENS: { address: Address; symbol: string; name: string; decimals: number; logoURI?: string }[] = [
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png' },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/2518/small/weth.png' },
  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png' },
  { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', name: 'USD Base Coin', decimals: 6, logoURI: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png' },
  { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/27008/small/cbeth.png' },
  { address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', symbol: 'rETH', name: 'Rocket Pool ETH', decimals: 18 },
  { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', symbol: 'wstETH', name: 'Wrapped stETH', decimals: 18 },
  { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', name: 'Aerodrome Finance', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/31745/small/token.png' },
  { address: '0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe', symbol: 'HIGHER', name: 'Higher', decimals: 18 },
  { address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', symbol: 'TOSHI', name: 'Toshi', decimals: 18 },
  { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT', name: 'Brett', decimals: 18 },
  { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', name: 'Degen', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/34515/small/android-chrome-192x192.png' },
  { address: '0xfA980cEd6895AC314E7dE34Ef1bFAE90a5AdD21b', symbol: 'PRIME', name: 'Echelon Prime', decimals: 18 },
  { address: '0x3C281A39944a2319aA653D81Cfd93Ca10983D234', symbol: 'MORPHO', name: 'Morpho', decimals: 18 },
  { address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', symbol: 'VIRTUAL', name: 'Virtual Protocol', decimals: 18 },
  { address: '0x22e6966B799c4D5B13BE962E1D117b56327FDa66', symbol: 'MOG', name: 'Mog Coin', decimals: 18 },
  { address: '0x9a26F5433671751C3276a065f57e5a02D2817973', symbol: 'KEYCAT', name: 'Keyboard Cat', decimals: 18 },
  { address: '0xBC45647eA894030a4E9801Ec03483fA34f5eED20', symbol: 'BALD', name: 'Bald', decimals: 18 },
  { address: '0xA88594D404727625A9437C3f886C7643872296AE', symbol: 'WELL', name: 'Moonwell', decimals: 18 },
  { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8 },
  { address: '0x6921B130D297cc43754afba22e5EAc0FBf8Db75b', symbol: 'doginme', name: 'doginme', decimals: 18 },
  { address: '0x7D49a065D17d6d4a55dc13649901fdBB98B2AFBA', symbol: 'SUSHI', name: 'SushiSwap', decimals: 18 },
  { address: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b', symbol: 'tBTC', name: 'tBTC v2', decimals: 18 },
  { address: '0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415', symbol: 'CRV', name: 'Curve DAO', decimals: 18 },
  { address: '0xCfA3Ef56d303AE4fAabA0592388F19d7C3399FB4', symbol: 'eUSD', name: 'Electronic Dollar', decimals: 18 },
];

// Uniswap V3 pools exist for these tokens — used to determine liquidity
const TOKENS_WITH_LIQUIDITY = new Set([
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
  '0x4200000000000000000000000000000000000006', // WETH
  '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
  '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // USDbC
  '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', // cbETH
  '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', // wstETH
  '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
  '0x532f27101965dd16442E59d40670FaF5eBB142E4', // BRETT
  '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', // DEGEN
  '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', // VIRTUAL
  '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
  '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', // rETH
  '0xA88594D404727625A9437C3f886C7643872296AE', // WELL
  '0x3C281A39944a2319aA653D81Cfd93Ca10983D234', // MORPHO
].map(a => a.toLowerCase()));

// ─── Price Fetching ──────────────────────────────────────────────────────────

interface PriceMap {
  [address: string]: number;
}

async function fetchPrices(tokenAddresses: Address[]): Promise<PriceMap> {
  const prices: PriceMap = {};

  // Try CoinGecko first (free, no API key needed)
  try {
    const addressList = tokenAddresses.map(a => a.toLowerCase()).join(',');
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${addressList}&vs_currencies=usd`,
      {
        headers: { 'Accept': 'application/json' },
        next: { revalidate: 60 }, // Cache for 60 seconds
      }
    );

    if (response.ok) {
      const data = await response.json();
      for (const [address, priceData] of Object.entries(data)) {
        const pd = priceData as { usd?: number };
        if (pd.usd) {
          prices[address.toLowerCase()] = pd.usd;
        }
      }
    }
  } catch (err) {
    console.error('CoinGecko price fetch failed:', err);
  }

  // Fallback: Try Oku API for missing prices
  const missingAddresses = tokenAddresses.filter(
    a => !prices[a.toLowerCase()]
  );

  if (missingAddresses.length > 0) {
    try {
      const response = await fetch('https://omni.icarus.tools/base/cush/analyticsTokenList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          params: {
            tokens: missingAddresses.map(a => a.toLowerCase()),
          },
        }),
        next: { revalidate: 60 },
      });

      if (response.ok) {
        const data = await response.json();
        if (data?.tokens) {
          for (const token of data.tokens) {
            if (token.price_usd && token.address) {
              prices[token.address.toLowerCase()] = Number(token.price_usd);
            }
          }
        }
      }
    } catch (err) {
      console.error('Oku price fetch failed:', err);
    }
  }

  // Hardcoded fallback for stablecoins
  const STABLE_PRICES: Record<string, number> = {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1.0,    // USDC
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 1.0,    // USDbC
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 1.0,    // DAI
    '0xcfa3ef56d303ae4faaba0592388f19d7c3399fb4': 1.0,    // eUSD
  };

  for (const [addr, price] of Object.entries(STABLE_PRICES)) {
    if (!prices[addr]) {
      prices[addr] = price;
    }
  }

  return prices;
}

// ─── Also scan for tokens via Alchemy/transfer logs ──────────────────────────

async function discoverTokensFromTransfers(walletAddress: Address): Promise<Address[]> {
  const discovered: Set<string> = new Set();

  // If Alchemy key is available, use it for token discovery
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (alchemyKey) {
    try {
      const response = await fetch(
        `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'alchemy_getTokenBalances',
            params: [walletAddress, 'erc20'],
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        const balances = data?.result?.tokenBalances || [];

        for (const tb of balances) {
          if (tb.tokenBalance && tb.tokenBalance !== '0x0' && tb.tokenBalance !== '0x') {
            const balance = BigInt(tb.tokenBalance);
            if (balance > 0n) {
              discovered.add(tb.contractAddress.toLowerCase());
            }
          }
        }
      }
    } catch (err) {
      console.error('Alchemy token discovery failed:', err);
    }
  }

  return Array.from(discovered).map(a => a as Address);
}

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address') as Address | null;
  const threshold = Number(searchParams.get('threshold') || '5');

  if (!address) {
    return NextResponse.json(
      { error: 'address parameter required' },
      { status: 400 }
    );
  }

  try {
    // Step 1: Collect all token addresses to scan
    const tokenAddressSet = new Set<string>(
      KNOWN_TOKENS.map(t => t.address.toLowerCase())
    );

    // Step 2: Discover additional tokens from Alchemy
    const discoveredTokens = await discoverTokensFromTransfers(address);
    for (const dt of discoveredTokens) {
      tokenAddressSet.add(dt.toLowerCase());
    }

    const allAddresses = Array.from(tokenAddressSet).map(a => a as Address);

    // Step 3: Batch-read balances using multicall
    const balanceCalls = allAddresses.map((tokenAddress) => ({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [address] as const,
    }));

    const balanceResults = await publicClient.multicall({
      contracts: balanceCalls,
      allowFailure: true,
    });

    // Step 4: Get token metadata for discovered tokens not in KNOWN_TOKENS
    const knownMap = new Map(
      KNOWN_TOKENS.map(t => [t.address.toLowerCase(), t])
    );

    // For unknown tokens, fetch name/symbol/decimals
    const unknownAddresses = allAddresses.filter(
      a => !knownMap.has(a.toLowerCase())
    );

    const metadataCalls: Array<{
      address: Address;
      abi: typeof erc20Abi;
      functionName: 'name' | 'symbol' | 'decimals';
    }> = [];

    for (const addr of unknownAddresses) {
      metadataCalls.push(
        { address: addr, abi: erc20Abi, functionName: 'name' },
        { address: addr, abi: erc20Abi, functionName: 'symbol' },
        { address: addr, abi: erc20Abi, functionName: 'decimals' },
      );
    }

    let metadataResults: Array<{ status: string; result?: unknown }> = [];
    if (metadataCalls.length > 0) {
      metadataResults = await publicClient.multicall({
        contracts: metadataCalls,
        allowFailure: true,
      });
    }

    // Build metadata map for unknown tokens
    const discoveredMetadata = new Map<string, { name: string; symbol: string; decimals: number }>();
    for (let i = 0; i < unknownAddresses.length; i++) {
      const nameResult = metadataResults[i * 3];
      const symbolResult = metadataResults[i * 3 + 1];
      const decimalsResult = metadataResults[i * 3 + 2];

      if (
        nameResult?.status === 'success' &&
        symbolResult?.status === 'success' &&
        decimalsResult?.status === 'success'
      ) {
        discoveredMetadata.set(unknownAddresses[i].toLowerCase(), {
          name: nameResult.result as string,
          symbol: symbolResult.result as string,
          decimals: Number(decimalsResult.result),
        });
      }
    }

    // Step 5: Get non-zero token addresses for price lookup
    const nonZeroAddresses: Address[] = [];
    const nonZeroBalances: Map<string, bigint> = new Map();

    for (let i = 0; i < allAddresses.length; i++) {
      const result = balanceResults[i];
      if (result.status === 'success' && result.result) {
        const balance = result.result as bigint;
        if (balance > 0n) {
          nonZeroAddresses.push(allAddresses[i]);
          nonZeroBalances.set(allAddresses[i].toLowerCase(), balance);
        }
      }
    }

    if (nonZeroAddresses.length === 0) {
      return NextResponse.json({ tokens: [] });
    }

    // Step 6: Fetch prices
    const prices = await fetchPrices(nonZeroAddresses);

    // Step 7: Build response tokens
    const tokens = [];

    for (const tokenAddress of nonZeroAddresses) {
      const addrLower = tokenAddress.toLowerCase();
      const balance = nonZeroBalances.get(addrLower);
      if (!balance) continue;

      // Get metadata
      const known = knownMap.get(addrLower);
      const discovered = discoveredMetadata.get(addrLower);
      const metadata = known || discovered;

      if (!metadata) continue; // Skip tokens we can't identify

      const decimals = metadata.decimals;
      const balanceFormatted = formatUnits(balance, decimals);
      const price = prices[addrLower] || 0;
      const usdValue = Number(balanceFormatted) * price;

      // Skip if above threshold or zero value with no price
      if (usdValue > threshold && price > 0) continue;
      // Skip WETH/ETH with significant value
      if (addrLower === '0x4200000000000000000000000000000000000006' && usdValue > threshold) continue;

      // Determine if token has Uniswap liquidity
      const hasLiquidity = TOKENS_WITH_LIQUIDITY.has(addrLower);

      tokens.push({
        address: tokenAddress,
        name: metadata.name,
        symbol: metadata.symbol,
        decimals,
        balance: balance.toString(),
        balanceFormatted,
        usdValue: Math.round(usdValue * 100) / 100,
        logoURI: known?.logoURI || null,
        hasLiquidity,
      });
    }

    // Sort: tokens with liquidity first, then by USD value descending
    tokens.sort((a, b) => {
      if (a.hasLiquidity !== b.hasLiquidity) return a.hasLiquidity ? -1 : 1;
      return b.usdValue - a.usdValue;
    });

    return NextResponse.json({ tokens });
  } catch (err) {
    console.error('Dust token fetch error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch tokens', message: String(err) },
      { status: 500 }
    );
  }
}
