import { Alchemy, Network } from 'alchemy-sdk';

// ─── Supported chains ─────────────────────────────────────────────────────────
const CHAINS: Record<string, { network: Network; name: string }> = {
  '8453':  { network: Network.BASE_MAINNET,  name: 'Base'          },
  '84532': { network: Network.BASE_SEPOLIA,  name: 'Base Sepolia'  },
  '1':     { network: Network.ETH_MAINNET,   name: 'Ethereum'      },
  '42161': { network: Network.ARB_MAINNET,   name: 'Arbitrum'      },
  '10':    { network: Network.OPT_MAINNET,   name: 'Optimism'      },
  '137':   { network: Network.MATIC_MAINNET, name: 'Polygon'       },
};

function getAlchemy(chainId: string): Alchemy {
  const cfg = CHAINS[chainId];
  if (!cfg) throw new Error(`Unsupported chain: ${chainId}`);
  return new Alchemy({ apiKey: process.env.ALCHEMY_API_KEY, network: cfg.network });
}

// ─── Types ───────────────────────────────────────────────────────────────────
export interface TokenBalance {
  tokenAddress:     string;
  symbol:           string;
  name:             string;
  balance:          string;
  decimals:         number;
  formattedBalance: string;
  estimatedValueUsd: number;
  hasLiquidity:     boolean;
  logoUrl?:         string;
}

export interface DustScanResult {
  chainId:           string;
  chainName:         string;
  dustTokens:        TokenBalance[];
  totalDustValueUsd: number;
  nonDustTokens:     TokenBalance[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Fetch token price from DexScreener (free, no API key required)
async function fetchPriceUsd(tokenAddress: string, chainId: string): Promise<number> {
  try {
    const chain = chainId === '8453' ? 'base'
      : chainId === '84532'  ? 'base'
      : chainId === '1'      ? 'ethereum'
      : chainId === '42161'  ? 'arbitrum'
      : chainId === '10'     ? 'optimism'
      : chainId === '137'    ? 'polygon'
      : 'base';

    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!res.ok) return 0;
    const data = await res.json() as { pairs?: Array<{ priceUsd?: string; chainId: string }> };

    const pair = data.pairs?.find(p => p.chainId === chain);
    return pair?.priceUsd ? parseFloat(pair.priceUsd) : 0;
  } catch {
    return 0;
  }
}

// ─── Core functions ───────────────────────────────────────────────────────────

export async function getTokenBalances(
  address: string,
  chainId: string,
): Promise<TokenBalance[]> {
  const alchemy  = getAlchemy(chainId);
  const response = await alchemy.core.getTokenBalances(address);

  const results: TokenBalance[] = [];

  for (const tok of response.tokenBalances) {
    if (!tok.tokenBalance || tok.tokenBalance === '0x0' || tok.tokenBalance === '0x') continue;

    try {
      const meta = await alchemy.core.getTokenMetadata(tok.contractAddress);
      if (!meta.symbol || meta.decimals == null) continue;

      const raw       = BigInt(tok.tokenBalance);
      const decimals  = meta.decimals;
      const formatted = Number(raw) / 10 ** decimals;
      if (formatted === 0) continue;

      const priceUsd = await fetchPriceUsd(tok.contractAddress, chainId);

      results.push({
        tokenAddress:      tok.contractAddress,
        symbol:            meta.symbol,
        name:              meta.name || meta.symbol,
        balance:           tok.tokenBalance,
        decimals,
        formattedBalance:  formatted.toFixed(6),
        estimatedValueUsd: formatted * priceUsd,
        hasLiquidity:      priceUsd > 0,
        logoUrl:           meta.logo ?? undefined,
      });
    } catch {
      // skip tokens where metadata fails
    }
  }

  return results;
}

export async function scanForDust(
  address: string,
  chainId: string,
): Promise<DustScanResult> {
  const cfg = CHAINS[chainId];
  if (!cfg) throw new Error(`Unsupported chain: ${chainId}`);

  const tokens = await getTokenBalances(address, chainId);

  const DUST_THRESHOLD = 2; // USD
  const dustTokens    = tokens.filter(t => t.estimatedValueUsd < DUST_THRESHOLD);
  const nonDustTokens = tokens.filter(t => t.estimatedValueUsd >= DUST_THRESHOLD);
  const totalDust     = dustTokens.reduce((s, t) => s + t.estimatedValueUsd, 0);

  return {
    chainId,
    chainName:         cfg.name,
    dustTokens,
    totalDustValueUsd: totalDust,
    nonDustTokens,
  };
}

export async function scanAllChains(address: string): Promise<DustScanResult[]> {
  const results = await Promise.allSettled(
    Object.keys(CHAINS).map(cid => scanForDust(address, cid))
  );
  return results
    .filter((r): r is PromiseFulfilledResult<DustScanResult> => r.status === 'fulfilled')
    .map(r => r.value);
}
