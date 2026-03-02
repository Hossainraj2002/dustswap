// apps/api/src/services/tokenDiscovery.ts

import {
  createPublicClient,
  http,
  getAddress,
  formatUnits,
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  type PublicClient,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TokenBalance {
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string; // raw bigint as string
  balanceFormatted: string; // human-readable
}

export interface TokenPrice {
  priceUsd: number;
  liquidity: number; // 0 = no liquidity / no route
}

export interface DustAnalysis {
  dustTokens: DustToken[];
  normalTokens: DustToken[];
  noLiquidityTokens: DustToken[];
  totalDustValueUsd: number;
  totalNormalValueUsd: number;
}

export interface DustToken extends TokenBalance {
  priceUsd: number;
  valueUsd: number;
  liquidity: number;
}

export interface SwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  poolFee: number;
  priceImpact: number;
  route: string;
  estimatedGas: string;
}

export interface BatchQuoteResult {
  quotes: (SwapQuote & { success: boolean; error?: string })[];
  totalAmountOut: string;
  dustSweepFeeBps: number;
  feeAmount: string;
  netOutput: string;
  tokenOut: string;
  successCount: number;
  failCount: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const UNISWAP_QUOTER_V2: Address =
  "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNISWAP_FACTORY: Address =
  "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DAI: Address = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";

const DUST_SWEEP_FEE_BPS = 200; // 2%
const BPS_DENOMINATOR = 10_000;

const FEE_TIERS: number[] = [500, 3000, 10000, 100];

// Top tokens on Base for fallback scanning
const TOP_BASE_TOKENS: Address[] = [
  "0x4200000000000000000000000000000000000006", // WETH
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
  "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
  "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
  "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", // rETH
  "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
  "0x4ed4E862860bed51a9570b96d89aF5E1B0Efefed", // DEGEN
  "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
  "0x532f27101965dd16442E59d40670FaF5eBB142E4", // BRETT
  "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", // TOSHI
  "0x6921B130D297cc43754afba22e5EAc0FBf8Db75b", // doginme
  "0xfA980cEd6895AC314E7dE34Ef1bFAE90a5AdD21b", // PRIME
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
  "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
  "0x78a087d713Be963Bf307b18F2Ff8122EF9A63ae9", // BSWAP
  "0x9e1028F5F1D5eDE59748FFceE5532509976840E0", // COMP
  "0xc5fecC3a29Fb57B5024eEc8a2239d4621e111CBE", // 1INCH
  "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", // tBTC
  "0xCfA3Ef56d303AE4fAabA0592388F19d7C3399FB4", // eUSD
  "0xA7d68d155d17cB30e311367c2Ef1E82aB6022b67", // Sushi
  "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe", // HIGHER
  "0xBC45647eA894030a4E9801Ec03479739FA2485F0", // NFTX
  "0xE1aBD004250AC8D1F199421d647e01d094FAa180", // SPEC
  "0x6985884C4392D348587B19cb9eAAf157F13271cd", // ZRO
  "0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415", // CRV
  "0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91", // W
  "0x3992B27dA26848C2b19CeA6Fd25ad5568B68AB98", // MOCHI
  "0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85", // SEAMLESSS
  "0xeFb97aaF77993922aC4be4Da8Fbc9A2425322677", // SDEX
  "0x22e6966B799c4D5B13BE962E1D117b56327FDa66", // MAVIA
  "0xcDa4e203Fdb2a6F2f6bB9B480bBf8e7C4aBa3565", // WELL
  "0x7D49a065D17d6d4a55dc13649901fdBB98B2AFBA", // SUSHI
  "0xdCe90fFd001d85CDf1e13b555Fd179532C1D055b", // PORK
  "0xAfb89a09D82FBDE58f18Ac6437B3fC81724e4dF6", // FX
  "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71", // MOG
  "0xB1a03EdA10342529bBF8EB700a06C60441fEf25d", // MIGGLES
  "0xac57De9C1A09FeC648E93EB98875B212DB0d5Da3", // KABOSU
  "0x628a3b2E302c7e896AcC432D2d0dD22B6cb9bc88", // ZORA
  "0x9a26F5433671751C3276a065f57e5a02D2817973", // KWENTA
  "0xDBFeFD2e8460a6Ee4955A68582F85708BAEA60A3", // SUPER
  "0x0DB510e79909666d6dEc7f5e49370838c16D950f", // API3
  "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196", // LINK
  "0x1bc0c42215582d5A085795559f1Beb5d6Bf25C51", // MKR
  "0x24fcFC492C1393274B6bcd568ac9e225BEc93584", // SNX
  "0x3e7eF8f50246f725885102E8238CBba33F276747", // BOND
  "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", // weETH
  "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH
  "0xCb327b99fF831bF8223cCEd12B1338FF3aA322Ff", // bsdETH
  "0xDBFefd2e8460a6Ee4955A68582F85708BAEA60A3", // SUPER
];

// ABIs for contract calls
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[]) returns ((bool success, bytes returnData)[])",
]);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) throw new Error(`Missing env: ${key}`);
  return value;
}

function optEnv(key: string): string | undefined {
  return process.env[key];
}

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
  backoffMs = 500
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) return response;

      // Rate limited – wait and retry
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : backoffMs * 2 ** attempt;
        await sleep(waitMs);
        continue;
      }

      // 5xx – retry with backoff
      if (response.status >= 500) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }

      // 4xx (non-429) – don't retry
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    } catch (err) {
      lastError = err as Error;
      if ((err as Error).name === "AbortError") {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      if (attempt < retries - 1) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
    }
  }

  throw lastError ?? new Error("fetchWithRetry exhausted");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupeAddresses(addresses: string[]): Address[] {
  const seen = new Set<string>();
  const result: Address[] = [];
  for (const addr of addresses) {
    const checksummed = getAddress(addr);
    if (!seen.has(checksummed.toLowerCase())) {
      seen.add(checksummed.toLowerCase());
      result.push(checksummed);
    }
  }
  return result;
}

// ─── TokenDiscovery Class ──────────────────────────────────────────────────────

export class TokenDiscovery {
  private client: PublicClient;
  private alchemyKey: string | undefined;
  private baseRpcUrl: string;
  private okuApiUrl: string;

  // Simple in-memory cache: tokenAddress → metadata
  private metadataCache: Map<
    string,
    { symbol: string; name: string; decimals: number; cachedAt: number }
  > = new Map();
  private static METADATA_TTL = 3600_000; // 1 hour

  // Price cache: tokenAddress → price
  private priceCache: Map<
    string,
    { priceUsd: number; liquidity: number; cachedAt: number }
  > = new Map();
  private static PRICE_TTL = 30_000; // 30 seconds

  constructor() {
    this.alchemyKey = optEnv("ALCHEMY_API_KEY");
    this.baseRpcUrl = env("BASE_RPC_URL", "https://mainnet.base.org");
    this.okuApiUrl = env("OKU_API_URL", "https://omni.icarus.tools");

    const rpcUrl = this.alchemyKey
      ? `https://base-mainnet.g.alchemy.com/v2/${this.alchemyKey}`
      : this.baseRpcUrl;

    this.client = createPublicClient({
      chain: base,
      transport: http(rpcUrl, {
        retryCount: 3,
        retryDelay: 500,
        timeout: 20_000,
      }),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. getTokenBalances
  // ═══════════════════════════════════════════════════════════════════════════

  async getTokenBalances(walletAddress: string): Promise<TokenBalance[]> {
    const wallet = getAddress(walletAddress);

    // Strategy A: Alchemy API (most comprehensive)
    if (this.alchemyKey) {
      try {
        const result = await this.getTokenBalancesAlchemy(wallet);
        if (result.length > 0) return result;
      } catch (err) {
        console.warn("[TokenDiscovery] Alchemy fallback triggered:", (err as Error).message);
      }
    }

    // Strategy B/C: Multicall against known token list
    try {
      return await this.getTokenBalancesMulticall(wallet);
    } catch (err) {
      console.error("[TokenDiscovery] All balance strategies failed:", (err as Error).message);
      return [];
    }
  }

  private async getTokenBalancesAlchemy(
    wallet: Address
  ): Promise<TokenBalance[]> {
    const url = `https://base-mainnet.g.alchemy.com/v2/${this.alchemyKey}`;

    // First call: get all token balances
    const balanceResponse = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getTokenBalances",
        params: [wallet, "erc20"],
      }),
    });

    const balanceData = await balanceResponse.json() as {
      result?: {
        tokenBalances: {
          contractAddress: string;
          tokenBalance: string;
          error: string | null;
        }[];
      };
      error?: { message: string };
    };

    if (balanceData.error) {
      throw new Error(`Alchemy error: ${balanceData.error.message}`);
    }

    const nonZeroBalances = (balanceData.result?.tokenBalances ?? []).filter(
      (tb) => {
        if (tb.error) return false;
        const val = BigInt(tb.tokenBalance ?? "0");
        return val > 0n;
      }
    );

    if (nonZeroBalances.length === 0) return [];

    // Fetch metadata for all tokens with non-zero balances
    const results: TokenBalance[] = [];

    // Process in batches of 25 to avoid overloading
    const BATCH = 25;
    for (let i = 0; i < nonZeroBalances.length; i += BATCH) {
      const batch = nonZeroBalances.slice(i, i + BATCH);

      const batchPromises = batch.map(async (tb) => {
        try {
          const addr = getAddress(tb.contractAddress);
          const meta = await this.getTokenMetadata(addr);
          const rawBalance = BigInt(tb.tokenBalance);

          return {
            tokenAddress: addr,
            symbol: meta.symbol,
            name: meta.name,
            decimals: meta.decimals,
            balance: rawBalance.toString(),
            balanceFormatted: formatUnits(rawBalance, meta.decimals),
          } as TokenBalance;
        } catch {
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    return results;
  }

  private async getTokenBalancesMulticall(
    wallet: Address
  ): Promise<TokenBalance[]> {
    const tokens = dedupeAddresses(TOP_BASE_TOKENS.map((t) => t));

    // Step 1: Multicall balanceOf for all tokens
    const balanceCalldata = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });

    const calls: { target: Address; allowFailure: boolean; callData: Hex }[] =
      tokens.map((token) => ({
        target: token,
        allowFailure: true,
        callData: balanceCalldata,
      }));

    let balanceResults: { success: boolean; returnData: Hex }[];

    try {
      balanceResults = (await this.client.simulateContract({
        address: MULTICALL3,
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [calls],
      })).result as { success: boolean; returnData: Hex }[];
    } catch {
      // If simulateContract fails, fall back to individual calls
      return await this.getTokenBalancesIndividual(wallet, tokens);
    }

    // Step 2: Filter non-zero balances
    const tokensWithBalance: { address: Address; balance: bigint }[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const result = balanceResults[i];
      if (!result || !result.success || result.returnData === "0x") continue;

      try {
        const decoded = decodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "balanceOf",
          data: result.returnData,
        });
        const balance = decoded as bigint;
        if (balance > 0n) {
          tokensWithBalance.push({ address: tokens[i]!, balance });
        }
      } catch {
        continue;
      }
    }

    if (tokensWithBalance.length === 0) return [];

    // Step 3: Fetch metadata for tokens with balances
    const results: TokenBalance[] = [];

    for (const { address: tokenAddr, balance } of tokensWithBalance) {
      try {
        const meta = await this.getTokenMetadata(tokenAddr);
        results.push({
          tokenAddress: tokenAddr,
          symbol: meta.symbol,
          name: meta.name,
          decimals: meta.decimals,
          balance: balance.toString(),
          balanceFormatted: formatUnits(balance, meta.decimals),
        });
      } catch {
        // Skip tokens with broken metadata
        continue;
      }
    }

    return results;
  }

  private async getTokenBalancesIndividual(
    wallet: Address,
    tokens: Address[]
  ): Promise<TokenBalance[]> {
    const results: TokenBalance[] = [];

    // Process in parallel batches of 10
    const BATCH = 10;
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      const batchPromises = batch.map(async (tokenAddr) => {
        try {
          const balance = await this.client.readContract({
            address: tokenAddr,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [wallet],
          });

          if (balance === 0n) return null;

          const meta = await this.getTokenMetadata(tokenAddr);
          return {
            tokenAddress: tokenAddr,
            symbol: meta.symbol,
            name: meta.name,
            decimals: meta.decimals,
            balance: balance.toString(),
            balanceFormatted: formatUnits(balance, meta.decimals),
          } as TokenBalance;
        } catch {
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    return results;
  }

  private async getTokenMetadata(
    tokenAddress: Address
  ): Promise<{ symbol: string; name: string; decimals: number }> {
    const key = tokenAddress.toLowerCase();
    const cached = this.metadataCache.get(key);
    if (cached && Date.now() - cached.cachedAt < TokenDiscovery.METADATA_TTL) {
      return cached;
    }

    // Try Alchemy metadata endpoint first if available
    if (this.alchemyKey) {
      try {
        const url = `https://base-mainnet.g.alchemy.com/v2/${this.alchemyKey}`;
        const resp = await fetchWithRetry(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "alchemy_getTokenMetadata",
            params: [tokenAddress],
          }),
        });
        const data = await resp.json() as {
          result?: { symbol: string; name: string; decimals: number };
        };
        if (data.result && data.result.symbol) {
          const meta = {
            symbol: data.result.symbol,
            name: data.result.name || data.result.symbol,
            decimals: data.result.decimals ?? 18,
            cachedAt: Date.now(),
          };
          this.metadataCache.set(key, meta);
          return meta;
        }
      } catch {
        // Fall through to on-chain
      }
    }

    // Fallback: read from contract directly
    const [symbol, name, decimals] = await Promise.all([
      this.client
        .readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "symbol",
        })
        .catch(() => "UNKNOWN"),
      this.client
        .readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "name",
        })
        .catch(() => "Unknown Token"),
      this.client
        .readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "decimals",
        })
        .catch(() => 18),
    ]);

    const meta = {
      symbol: symbol as string,
      name: name as string,
      decimals: Number(decimals),
      cachedAt: Date.now(),
    };
    this.metadataCache.set(key, meta);
    return meta;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. getTokenPrices
  // ═══════════════════════════════════════════════════════════════════════════

  async getTokenPrices(
    tokenAddresses: string[]
  ): Promise<Map<string, TokenPrice>> {
    const addresses = dedupeAddresses(tokenAddresses);
    const priceMap = new Map<string, TokenPrice>();

    // Check cache first
    const uncached: Address[] = [];
    for (const addr of addresses) {
      const key = addr.toLowerCase();
      const cached = this.priceCache.get(key);
      if (cached && Date.now() - cached.cachedAt < TokenDiscovery.PRICE_TTL) {
        priceMap.set(addr, {
          priceUsd: cached.priceUsd,
          liquidity: cached.liquidity,
        });
      } else {
        uncached.push(addr);
      }
    }

    if (uncached.length === 0) return priceMap;

    // Strategy A: Oku Trade API
    try {
      const okuPrices = await this.getPricesOku(uncached);
      let allResolved = true;

      for (const addr of uncached) {
        const price = okuPrices.get(addr);
        if (price && price.priceUsd > 0) {
          priceMap.set(addr, price);
          this.priceCache.set(addr.toLowerCase(), {
            ...price,
            cachedAt: Date.now(),
          });
        } else {
          allResolved = false;
        }
      }

      if (allResolved) return priceMap;
    } catch (err) {
      console.warn("[TokenDiscovery] Oku pricing failed:", (err as Error).message);
    }

    // Strategy B: CoinGecko API (for tokens still missing prices)
    const stillMissing = uncached.filter((a) => !priceMap.has(a));
    if (stillMissing.length > 0) {
      try {
        const geckoResult = await this.getPricesCoinGecko(stillMissing);
        for (const addr of stillMissing) {
          const price = geckoResult.get(addr);
          if (price && price.priceUsd > 0) {
            priceMap.set(addr, price);
            this.priceCache.set(addr.toLowerCase(), {
              ...price,
              cachedAt: Date.now(),
            });
          }
        }
      } catch (err) {
        console.warn("[TokenDiscovery] CoinGecko pricing failed:", (err as Error).message);
      }
    }

    // Strategy C: Uniswap V3 Quoter (for tokens still missing)
    const finalMissing = uncached.filter((a) => !priceMap.has(a));
    if (finalMissing.length > 0) {
      for (const addr of finalMissing) {
        try {
          const price = await this.getPriceViaQuoter(addr);
          priceMap.set(addr, price);
          this.priceCache.set(addr.toLowerCase(), {
            ...price,
            cachedAt: Date.now(),
          });
        } catch {
          // No route – mark as no liquidity
          const noLiq: TokenPrice = { priceUsd: 0, liquidity: 0 };
          priceMap.set(addr, noLiq);
          this.priceCache.set(addr.toLowerCase(), {
            ...noLiq,
            cachedAt: Date.now(),
          });
        }
      }
    }

    return priceMap;
  }

  private async getPricesOku(
    tokens: Address[]
  ): Promise<Map<string, TokenPrice>> {
    const priceMap = new Map<string, TokenPrice>();

    // Oku /v1/base/tokens endpoint
    // POST body with token addresses
    const url = `${this.okuApiUrl}/v1/base/tokens`;

    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokens: tokens.map((t) => t.toLowerCase()),
      }),
    });

    const data = await response.json() as Record<
      string,
      {
        price_usd?: number;
        priceUSD?: number;
        totalValueLockedUSD?: number;
        tvlUSD?: number;
        liquidity?: number;
      }
    >;

    // Oku returns a map keyed by lowercase address
    for (const addr of tokens) {
      const key = addr.toLowerCase();
      const tokenData = data[key];
      if (tokenData) {
        const priceUsd =
          tokenData.price_usd ?? tokenData.priceUSD ?? 0;
        const liquidity =
          tokenData.totalValueLockedUSD ??
          tokenData.tvlUSD ??
          tokenData.liquidity ??
          (priceUsd > 0 ? 1 : 0); // If there's a price, assume some liquidity

        priceMap.set(addr, { priceUsd, liquidity });
      }
    }

    return priceMap;
  }

  private async getPricesCoinGecko(
    tokens: Address[]
  ): Promise<Map<string, TokenPrice>> {
    const priceMap = new Map<string, TokenPrice>();

    // CoinGecko free API: /api/v3/simple/token_price/base
    const addressList = tokens.map((t) => t.toLowerCase()).join(",");
    const url =
      `https://api.coingecko.com/api/v3/simple/token_price/base` +
      `?contract_addresses=${addressList}` +
      `&vs_currencies=usd`;

    const response = await fetchWithRetry(url);
    const data = await response.json() as Record<
      string,
      { usd?: number }
    >;

    for (const addr of tokens) {
      const key = addr.toLowerCase();
      const tokenData = data[key];
      if (tokenData && tokenData.usd && tokenData.usd > 0) {
        priceMap.set(addr, {
          priceUsd: tokenData.usd,
          liquidity: 1, // CoinGecko doesn't provide liquidity directly
        });
      }
    }

    return priceMap;
  }

  private async getPriceViaQuoter(tokenAddress: Address): Promise<TokenPrice> {
    // Price a token by quoting 1 unit against USDC through Uniswap V3
    // If the token IS USDC, return $1
    if (tokenAddress.toLowerCase() === USDC.toLowerCase()) {
      return { priceUsd: 1.0, liquidity: 1 };
    }

    // If token is WETH, quote WETH → USDC
    // For others, try tokenIn → USDC directly, then tokenIn → WETH → USDC

    const meta = await this.getTokenMetadata(tokenAddress);
    const oneUnit = 10n ** BigInt(meta.decimals);

    // Try direct: token → USDC
    for (const fee of FEE_TIERS) {
      try {
        const result = await this.client.simulateContract({
          address: UNISWAP_QUOTER_V2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: tokenAddress,
              tokenOut: USDC,
              amountIn: oneUnit,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });

        const amountOut = result.result[0] as bigint;
        // USDC has 6 decimals
        const priceUsd = Number(formatUnits(amountOut, 6));

        if (priceUsd > 0) {
          return { priceUsd, liquidity: 1 };
        }
      } catch {
        continue;
      }
    }

    // Try two-hop: token → WETH → USDC
    if (tokenAddress.toLowerCase() !== WETH.toLowerCase()) {
      for (const fee1 of FEE_TIERS) {
        try {
          // Step 1: token → WETH
          const step1 = await this.client.simulateContract({
            address: UNISWAP_QUOTER_V2,
            abi: QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: tokenAddress,
                tokenOut: WETH,
                amountIn: oneUnit,
                fee: fee1,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });

          const wethAmount = step1.result[0] as bigint;
          if (wethAmount === 0n) continue;

          // Step 2: WETH → USDC (use 500 fee tier, most liquid)
          for (const fee2 of [500, 3000]) {
            try {
              const step2 = await this.client.simulateContract({
                address: UNISWAP_QUOTER_V2,
                abi: QUOTER_V2_ABI,
                functionName: "quoteExactInputSingle",
                args: [
                  {
                    tokenIn: WETH,
                    tokenOut: USDC,
                    amountIn: wethAmount,
                    fee: fee2,
                    sqrtPriceLimitX96: 0n,
                  },
                ],
              });

              const usdcAmount = step2.result[0] as bigint;
              const priceUsd = Number(formatUnits(usdcAmount, 6));

              if (priceUsd > 0) {
                return { priceUsd, liquidity: 1 };
              }
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
      }
    }

    // No route found
    return { priceUsd: 0, liquidity: 0 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. getDustTokens
  // ═══════════════════════════════════════════════════════════════════════════

  async getDustTokens(
    walletAddress: string,
    thresholdUsd: number = 2.0
  ): Promise<DustAnalysis> {
    const balances = await this.getTokenBalances(walletAddress);

    if (balances.length === 0) {
      return {
        dustTokens: [],
        normalTokens: [],
        noLiquidityTokens: [],
        totalDustValueUsd: 0,
        totalNormalValueUsd: 0,
      };
    }

    // Fetch prices for all tokens with balances
    const tokenAddresses = balances.map((b) => b.tokenAddress);
    const prices = await this.getTokenPrices(tokenAddresses);

    const dustTokens: DustToken[] = [];
    const normalTokens: DustToken[] = [];
    const noLiquidityTokens: DustToken[] = [];

    for (const balance of balances) {
      const price = prices.get(balance.tokenAddress) ?? {
        priceUsd: 0,
        liquidity: 0,
      };

      const valueUsd =
        parseFloat(balance.balanceFormatted) * price.priceUsd;

      const dustToken: DustToken = {
        ...balance,
        priceUsd: price.priceUsd,
        valueUsd,
        liquidity: price.liquidity,
      };

      if (price.liquidity === 0 || price.priceUsd === 0) {
        noLiquidityTokens.push(dustToken);
      } else if (valueUsd < thresholdUsd) {
        dustTokens.push(dustToken);
      } else {
        normalTokens.push(dustToken);
      }
    }

    // Sort dust tokens by value descending (most valuable dust first)
    dustTokens.sort((a, b) => b.valueUsd - a.valueUsd);
    normalTokens.sort((a, b) => b.valueUsd - a.valueUsd);
    noLiquidityTokens.sort((a, b) => {
      // Sort by raw balance descending for no-liquidity tokens
      return (
        parseFloat(b.balanceFormatted) - parseFloat(a.balanceFormatted)
      );
    });

    const totalDustValueUsd = dustTokens.reduce(
      (sum, t) => sum + t.valueUsd,
      0
    );
    const totalNormalValueUsd = normalTokens.reduce(
      (sum, t) => sum + t.valueUsd,
      0
    );

    return {
      dustTokens,
      normalTokens,
      noLiquidityTokens,
      totalDustValueUsd,
      totalNormalValueUsd,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. getSwapQuote
  // ═══════════════════════════════════════════════════════════════════════════

  async getSwapQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ): Promise<SwapQuote> {
    const tokenInAddr = getAddress(tokenIn);
    const tokenOutAddr = getAddress(tokenOut);
    const amountInBn = BigInt(amountIn);

    if (amountInBn === 0n) {
      throw new Error("amountIn must be > 0");
    }

    // Strategy A: Oku Trade API quote
    try {
      const okuQuote = await this.getQuoteOku(
        tokenInAddr,
        tokenOutAddr,
        amountIn
      );
      if (okuQuote) return okuQuote;
    } catch (err) {
      console.warn("[TokenDiscovery] Oku quote failed:", (err as Error).message);
    }

    // Strategy B: Direct Uniswap V3 Quoter – try all fee tiers
    let bestQuote: SwapQuote | null = null;
    let bestAmountOut = 0n;

    for (const fee of FEE_TIERS) {
      try {
        const result = await this.client.simulateContract({
          address: UNISWAP_QUOTER_V2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: tokenInAddr,
              tokenOut: tokenOutAddr,
              amountIn: amountInBn,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });

        const [amountOut, , , gasEstimate] = result.result as [
          bigint,
          bigint,
          number,
          bigint,
        ];

        if (amountOut > bestAmountOut) {
          bestAmountOut = amountOut;

          // Estimate price impact
          const priceImpact = await this.estimatePriceImpact(
            tokenInAddr,
            tokenOutAddr,
            amountInBn,
            amountOut,
            fee
          );

          bestQuote = {
            tokenIn: tokenInAddr,
            tokenOut: tokenOutAddr,
            amountIn: amountInBn.toString(),
            amountOut: amountOut.toString(),
            poolFee: fee,
            priceImpact,
            route: `${tokenInAddr} → [${fee / 10000}%] → ${tokenOutAddr}`,
            estimatedGas: gasEstimate.toString(),
          };
        }
      } catch {
        // This fee tier doesn't have a pool or enough liquidity
        continue;
      }
    }

    // Strategy C: Two-hop through WETH if direct quote fails
    if (
      !bestQuote &&
      tokenInAddr.toLowerCase() !== WETH.toLowerCase() &&
      tokenOutAddr.toLowerCase() !== WETH.toLowerCase()
    ) {
      bestQuote = await this.getTwoHopQuote(
        tokenInAddr,
        tokenOutAddr,
        amountInBn
      );
    }

    if (!bestQuote) {
      throw new Error(
        `No route found: ${tokenInAddr} → ${tokenOutAddr} for amount ${amountIn}`
      );
    }

    return bestQuote;
  }

  private async getQuoteOku(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: string
  ): Promise<SwapQuote | null> {
    const url = `${this.okuApiUrl}/v1/base/quote`;

    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenIn: tokenIn.toLowerCase(),
        tokenOut: tokenOut.toLowerCase(),
        amountIn,
        slippage: 0.5, // 0.5%
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      amountOut?: string;
      quote?: string;
      poolFee?: number;
      fee?: number;
      priceImpact?: number;
      route?: string;
      gasEstimate?: string;
    };

    const amountOut = data.amountOut ?? data.quote;
    if (!amountOut || BigInt(amountOut) === 0n) return null;

    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      poolFee: data.poolFee ?? data.fee ?? 3000,
      priceImpact: data.priceImpact ?? 0,
      route: data.route ?? `${tokenIn} → ${tokenOut} (oku)`,
      estimatedGas: data.gasEstimate ?? "200000",
    };
  }

  private async getTwoHopQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<SwapQuote | null> {
    let bestAmountOut = 0n;
    let bestFee1 = 0;
    let bestFee2 = 0;
    let bestGas = 0n;
    let bestWethMid = 0n;

    for (const fee1 of FEE_TIERS) {
      let step1Out: bigint;
      let step1Gas: bigint;

      try {
        const result = await this.client.simulateContract({
          address: UNISWAP_QUOTER_V2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut: WETH,
              amountIn,
              fee: fee1,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });

        step1Out = result.result[0] as bigint;
        step1Gas = result.result[3] as bigint;

        if (step1Out === 0n) continue;
      } catch {
        continue;
      }

      for (const fee2 of FEE_TIERS) {
        try {
          const result = await this.client.simulateContract({
            address: UNISWAP_QUOTER_V2,
            abi: QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: WETH,
                tokenOut,
                amountIn: step1Out,
                fee: fee2,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });

          const step2Out = result.result[0] as bigint;
          const step2Gas = result.result[3] as bigint;

          if (step2Out > bestAmountOut) {
            bestAmountOut = step2Out;
            bestFee1 = fee1;
            bestFee2 = fee2;
            bestGas = step1Gas + step2Gas;
            bestWethMid = step1Out;
          }
        } catch {
          continue;
        }
      }
    }

    if (bestAmountOut === 0n) return null;

    const priceImpact = await this.estimatePriceImpactTwoHop(
      tokenIn,
      tokenOut,
      amountIn,
      bestAmountOut
    );

    return {
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: bestAmountOut.toString(),
      poolFee: bestFee1, // primary fee tier
      priceImpact,
      route: `${tokenIn} → [${bestFee1 / 10000}%] → WETH → [${bestFee2 / 10000}%] → ${tokenOut}`,
      estimatedGas: bestGas.toString(),
    };
  }

  private async estimatePriceImpact(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    amountOut: bigint,
    fee: number
  ): Promise<number> {
    try {
      // Get a quote for 1/100th of the amount as the "reference" price
      const smallAmount = amountIn / 100n || 1n;

      const result = await this.client.simulateContract({
        address: UNISWAP_QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn: smallAmount,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const smallOut = result.result[0] as bigint;
      if (smallOut === 0n) return 0;

      // Reference rate: smallOut / smallAmount
      // Actual rate: amountOut / amountIn
      // Price impact = 1 - (actualRate / referenceRate)
      const referenceRate =
        (Number(smallOut) * Number(amountIn)) /
        (Number(smallAmount) * Number(amountOut));

      const impact = Math.max(0, (1 - 1 / referenceRate) * 100);
      return Math.round(impact * 100) / 100; // 2 decimal places
    } catch {
      return 0;
    }
  }

  private async estimatePriceImpactTwoHop(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    amountOut: bigint
  ): Promise<number> {
    try {
      // Estimate impact by comparing against a small trade
      const smallAmount = amountIn / 100n || 1n;
      const smallQuote = await this.getSwapQuote(
        tokenIn,
        tokenOut,
        smallAmount.toString()
      );
      const smallOut = BigInt(smallQuote.amountOut);
      if (smallOut === 0n) return 0;

      const referenceRate =
        (Number(smallOut) * Number(amountIn)) /
        (Number(smallAmount) * Number(amountOut));

      const impact = Math.max(0, (1 - 1 / referenceRate) * 100);
      return Math.round(impact * 100) / 100;
    } catch {
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. getBatchQuotes
  // ═══════════════════════════════════════════════════════════════════════════

  async getBatchQuotes(
    orders: { tokenIn: string; amountIn: string }[],
    tokenOut: string
  ): Promise<BatchQuoteResult> {
    const tokenOutAddr = getAddress(tokenOut);
    const tokenOutMeta = await this.getTokenMetadata(tokenOutAddr);

    const quotes: (SwapQuote & { success: boolean; error?: string })[] = [];
    let totalAmountOut = 0n;
    let successCount = 0;
    let failCount = 0;

    // Process quotes in parallel batches of 5 to avoid rate limits
    const BATCH = 5;
    for (let i = 0; i < orders.length; i += BATCH) {
      const batch = orders.slice(i, i + BATCH);

      const batchPromises = batch.map(async (order) => {
        try {
          const quote = await this.getSwapQuote(
            order.tokenIn,
            tokenOut,
            order.amountIn
          );
          return { ...quote, success: true };
        } catch (err) {
          return {
            tokenIn: getAddress(order.tokenIn),
            tokenOut: tokenOutAddr,
            amountIn: order.amountIn,
            amountOut: "0",
            poolFee: 0,
            priceImpact: 0,
            route: "no route",
            estimatedGas: "0",
            success: false,
            error: (err as Error).message,
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        quotes.push(result);
        if (result.success) {
          totalAmountOut += BigInt(result.amountOut);
          successCount++;
        } else {
          failCount++;
        }
      }
    }

    // Calculate dust sweep fee: 2% of total output
    const feeAmount =
      (totalAmountOut * BigInt(DUST_SWEEP_FEE_BPS)) /
      BigInt(BPS_DENOMINATOR);
    const netOutput = totalAmountOut - feeAmount;

    return {
      quotes,
      totalAmountOut: totalAmountOut.toString(),
      dustSweepFeeBps: DUST_SWEEP_FEE_BPS,
      feeAmount: feeAmount.toString(),
      netOutput: netOutput.toString(),
      tokenOut: tokenOutAddr,
      successCount,
      failCount,
    };
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

let instance: TokenDiscovery | null = null;

export function getTokenDiscovery(): TokenDiscovery {
  if (!instance) {
    instance = new TokenDiscovery();
  }
  return instance;
}