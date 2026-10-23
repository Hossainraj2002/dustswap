// Read-only market/route coverage audit. No .env loading, wallet, signing or broadcasts.
// From repository root:
// node apps/api/scripts/check-optimism-liquidity.cjs --metadata-only --output output/op-market.json
// node apps/api/scripts/check-optimism-liquidity.cjs --from-metadata output/op-market.json --output output/op-routes.json
// A positive public quote demonstrates an available route, not execution for every token.
const fs = require('node:fs');
const path = require('node:path');
const { parseUnits } = require('viem');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const metadataOnly = args.includes('--metadata-only');
const input = option('--from-metadata', null);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.resolve(option('--output', `output/optimism-universe-${stamp}.json`));
const usd = Number(option('--usd', '1'));
const limit = Number(option('--limit', '0'));
const minLiquidity = Number(option('--min-liquidity', '0'));
if (!(usd > 0) || !Number.isFinite(usd) || !Number.isInteger(limit) || limit < 0 || !Number.isFinite(minLiquidity) || minLiquidity < 0) {
  throw new Error('Use positive finite --usd and nonnegative --limit/--min-liquidity.');
}
const USDC = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';
const WETH = '0x4200000000000000000000000000000000000006';
const KYBER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const TOKEN_LIST = 'https://raw.githubusercontent.com/ethereum-optimism/ethereum-optimism.github.io/master/optimism.tokenlist.json';
const LIFI_TOKENS = 'https://li.quest/v1/tokens?chains=10';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const save = (report) => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
};

async function readJson(url, timeout = 8000) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'x-client-id': 'dustswap-coverage-audit' },
      signal: AbortSignal.timeout(timeout),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, elapsedMs: Date.now() - started };
  } catch (error) {
    return { status: 0, body: null, elapsedMs: Date.now() - started, error: error.message };
  }
}

async function metadata() {
  const list = await readJson(TOKEN_LIST, 15000);
  if (list.status !== 200 || !Array.isArray(list.body?.tokens)) throw new Error('Official token list unavailable.');
  const unique = new Map();
  for (const token of list.body.tokens) {
    if (Number(token.chainId) !== 10 || !/^0x[0-9a-f]{40}$/i.test(token.address)) continue;
    if (token.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') continue;
    unique.set(token.address.toLowerCase(), {
      address: token.address.toLowerCase(), symbol: token.symbol, decimals: token.decimals,
      priceUSD: 0, priceSource: null, bestIndexedLiquidityUSD: 0, indexedDexes: [], quote: null,
    });
  }
  const prices = await readJson(LIFI_TOKENS, 20000);
  for (const token of prices.body?.tokens?.['10'] || []) {
    const row = unique.get(String(token.address).toLowerCase());
    if (row && positive(token.priceUSD)) {
      row.priceUSD = positive(token.priceUSD);
      row.priceSource = 'li.fi';
    }
  }
  const addresses = [...unique.keys()];
  const marketReads = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const url = `https://api.dexscreener.com/tokens/v1/optimism/${batch.join(',')}`;
    const result = await readJson(url, 15000);
    marketReads.push({ batchSize: batch.length, status: result.status, elapsedMs: result.elapsedMs });
    if (Array.isArray(result.body)) {
      for (const pair of result.body) {
        if (pair.chainId !== 'optimism') continue;
        for (const role of ['baseToken', 'quoteToken']) {
          const row = unique.get(String(pair[role]?.address).toLowerCase());
          if (!row) continue;
          const liquidity = positive(pair.liquidity?.usd);
          if (pair.dexId && !row.indexedDexes.includes(pair.dexId)) row.indexedDexes.push(pair.dexId);
          if (liquidity > row.bestIndexedLiquidityUSD) {
            row.bestIndexedLiquidityUSD = liquidity;
            row.bestIndexedPair = pair.pairAddress;
          }
          if (!row.priceUSD && liquidity >= 1000) {
            const price = role === 'baseToken'
              ? positive(pair.priceUsd)
              : positive(pair.priceUsd) / positive(pair.priceNative);
            if (positive(price)) {
              row.priceUSD = price;
              row.priceSource = 'dexscreener-pair>=1000usd';
            }
          }
        }
      }
    }
    await wait(300);
  }
  return {
    observedAtUTC: new Date().toISOString(), chainId: 10,
    population: 'Unique ERC-20 entries in the official Optimism token list; not all tokens on OP.',
    tokenList: { url: TOKEN_LIST, timestamp: list.body.timestamp },
    priceRead: { url: LIFI_TOKENS, status: prices.status }, marketReads,
    rows: [...unique.values()],
  };
}

async function main() {
  const report = input ? JSON.parse(fs.readFileSync(input, 'utf8')) : await metadata();
  for (const row of report.rows) row.quote = null;
  report.method = { quotedUSDApprox: usd, provider: 'Kyber public route API', timeoutMs: 8000, minimumPauseMs: 300,
    minimumIndexedLiquidityUSD: minLiquidity,
    buildOrExecutionTest: false, warning: 'Recorded prices size inputs approximately and may be stale; positive routes do not establish fair value or execution.' };
  save(report);
  if (!metadataOnly) {
    const eligible = report.rows.filter((row) => row.priceUSD > 0 && row.bestIndexedLiquidityUSD >= minLiquidity);
    const selected = limit > 0 ? eligible.slice(0, limit) : eligible;
    report.selectedEntries = selected.length;
    for (const [index, row] of selected.entries()) {
      const human = usd / row.priceUSD;
      let amount;
      try {
        amount = parseUnits(human.toFixed(Math.min(Number(row.decimals), 18)), Number(row.decimals));
        if (amount <= 0n) throw new Error('Below one base unit');
      } catch (error) {
        row.quote = { status: 'amount_not_representable', error: error.message };
        continue;
      }
      const tokenOut = row.address === USDC ? WETH : USDC;
      const url = new URL('https://aggregator-api.kyberswap.com/optimism/api/v1/routes');
      url.search = new URLSearchParams({ tokenIn: row.address, tokenOut, amountIn: amount.toString() }).toString();
      const result = await readJson(url);
      const summary = result.body?.data?.routeSummary;
      const target = String(result.body?.data?.routerAddress || '').toLowerCase();
      const hasOutput = /^\d+$/.test(String(summary?.amountOut)) && BigInt(summary.amountOut) > 0n;
      const transient = result.status === 0 || result.status === 408 || result.status === 425 || result.status === 429 || result.status >= 500;
      const route = Array.isArray(summary?.route) ? summary.route.flat(Infinity) : [];
      row.quote = {
        status: result.status === 200 && Number(result.body?.code) === 0 && hasOutput && target === KYBER
          ? 'quoted' : transient ? 'provider_transient' : 'no_valid_quote',
        amountIn: amount.toString(), tokenOut, amountOut: summary?.amountOut || null,
        httpStatus: result.status, providerCode: result.body?.code, message: result.body?.message || result.error || null,
        elapsedMs: result.elapsedMs, checkedAtUTC: new Date().toISOString(),
        dexes: [...new Set(route.map((leg) => leg.exchange).filter(Boolean))],
        pools: [...new Set(route.map((leg) => leg.pool).filter(Boolean))],
      };
      report.quoteProgress = { completed: index + 1, selected: selected.length };
      save(report);
      if ((index + 1) % 10 === 0) console.log(`Quoted ${index + 1}/${selected.length} priced entries`);
      await wait(300);
    }
  }
  const count = (predicate) => report.rows.filter(predicate).length;
  report.completedAtUTC = new Date().toISOString();
  report.summary = {
    listed: report.rows.length, priced: count((r) => r.priceUSD > 0), unpriced: count((r) => !r.priceUSD),
    indexedLiquidityAbove1000USD: count((r) => r.bestIndexedLiquidityUSD >= 1000),
    liquidityBackedQuoted: count((r) => r.bestIndexedLiquidityUSD >= 1000 && r.quote?.status === 'quoted'),
    quoted: count((r) => r.quote?.status === 'quoted'), noValidQuote: count((r) => r.quote?.status === 'no_valid_quote'),
    providerTransient: count((r) => r.quote?.status === 'provider_transient'),
    notAttempted: count((r) => !r.quote), amountNotRepresentable: count((r) => r.quote?.status === 'amount_not_representable'),
  };
  save(report);
  console.log(JSON.stringify({ output, ...report.summary }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
