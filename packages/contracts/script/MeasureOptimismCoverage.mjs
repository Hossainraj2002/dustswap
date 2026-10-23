// Read-only metadata and public quote measurement. Never signs or broadcasts transactions.
// Run: node packages/contracts/script/MeasureOptimismCoverage.mjs
// Optional: OPTIMISM_MAINNET_RPC_URL, OPTIMISM_COVERAGE_OUTPUT_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outputDir = path.resolve(process.env.OPTIMISM_COVERAGE_OUTPUT_DIR || path.join(root, 'output/optimism-coverage'));
const rpc = process.env.OPTIMISM_MAINNET_RPC_URL || 'https://mainnet.optimism.io';
const tokenListUrl = 'https://raw.githubusercontent.com/ethereum-optimism/ethereum-optimism.github.io/master/optimism.tokenlist.json';
const veloSource = 'https://raw.githubusercontent.com/velodrome-finance/contracts/main/README.md';
const priceUrl = 'https://li.quest/v1/tokens?chains=10';
const USDC = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';
const WETH = '0x4200000000000000000000000000000000000006';
const taker = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f';
const kyberTarget = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const lifiTarget = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const symbols = ['USDC', 'USDC.e', 'USDT', 'USD₮0', 'DAI', 'WBTC', 'OP', 'VELO', 'SNX', 'wstETH', 'LUSD', 'sUSD', 'sETH', 'LINK', 'AAVE', 'UNI', 'PEPE', 'WETH'];
const startedAt = new Date().toISOString();
let lastRequest = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(url, options = {}) {
  const delay = 275 - (Date.now() - lastRequest);
  if (delay > 0) await pause(delay);
  lastRequest = Date.now();
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json', 'x-client-id': 'dustswap', ...options.headers } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 1000) }; }
  return { status: response.status, ok: response.ok, body };
}

async function json(url, options) {
  const result = await request(url, options);
  if (!result.ok) throw new Error(`HTTP ${result.status} from ${url}: ${JSON.stringify(result.body).slice(0, 300)}`);
  return result.body;
}

let rpcId = 0;
async function rpcBatch(calls) {
  const batch = calls.map(([method, params]) => ({ jsonrpc: '2.0', id: ++rpcId, method, params }));
  const results = await json(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
  if (!Array.isArray(results)) throw new Error('RPC did not return a JSON-RPC batch');
  const byId = new Map(results.map(row => [row.id, row]));
  return batch.map(row => byId.get(row.id) || { error: { message: 'missing RPC result' } });
}

function decodeString(hex) {
  const data = Buffer.from(hex.slice(2), 'hex');
  if (data.length === 32) return data.toString('utf8').replace(/\0+$/g, '');
  if (data.length < 64) throw new Error('short ABI string');
  const offset = Number(BigInt('0x' + data.subarray(0, 32).toString('hex')));
  if (!Number.isSafeInteger(offset) || offset + 32 > data.length) throw new Error('bad ABI string offset');
  const size = Number(BigInt('0x' + data.subarray(offset, offset + 32).toString('hex')));
  if (!Number.isSafeInteger(size) || offset + 32 + size > data.length) throw new Error('bad ABI string length');
  return data.subarray(offset + 32, offset + 32 + size).toString('utf8');
}

function integerForUsd(usd, price, decimals) {
  // Decimal rational arithmetic avoids float rounding of ERC-20 integer amounts.
  const fixed = Number(price).toFixed(15);
  const scale = 10n ** 15n;
  const integerPrice = BigInt(fixed.replace('.', ''));
  if (integerPrice <= 0n) throw new Error('price below measurement precision');
  return (BigInt(usd) * 10n ** BigInt(decimals) * scale / integerPrice).toString();
}

const tokenList = await json(tokenListUrl);
const chainTokens = tokenList.tokens.filter(token => token.chainId === 10);
const tokens = chainTokens.filter(token => symbols.includes(token.symbol) || token.name === 'Rocket Pool ETH')
  .map(token => ({ ...token, label: token.symbol === 'VELO' ? 'VELO v1' : token.symbol, addressSource: tokenListUrl }));
const veloReadme = await fetch(veloSource).then(response => { if (!response.ok) throw new Error('Velodrome deployment source unavailable'); return response.text(); });
const veloV2 = '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db';
if (!veloReadme.toLowerCase().includes(veloV2.toLowerCase())) throw new Error('VELO V2 absent from official deployment table');
tokens.push({ symbol: 'VELO', label: 'VELO v2', name: 'VelodromeV2', decimals: 18, address: veloV2, addressSource: veloSource });
tokens.sort((a, b) => a.label.localeCompare(b.label));
const priceData = await json(priceUrl);
const prices = new Map((priceData.tokens?.['10'] || []).map(token => [token.address.toLowerCase(), token]));
const [chainResult, blockResult] = await rpcBatch([['eth_chainId', []], ['eth_blockNumber', []]]);
if (chainResult.result !== '0xa' || !blockResult.result) throw new Error('RPC is not OP Mainnet');
const blockTag = blockResult.result;
const results = [];
const metadata = [];
fs.mkdirSync(outputDir, { recursive: true });
const stamp = startedAt.replace(/[:.]/g, '-');
const outputPath = path.join(outputDir, `coverage-${stamp}.json`);

function snapshot() {
  const summary = {
    sampledTokens: tokens.length,
    officialListPopulation: chainTokens.length,
    officialListSampled: tokens.filter(token => token.addressSource === tokenListUrl).length,
    metadataPassed: metadata.filter(row => row.status === 'ok').length,
    metadataFailed: metadata.filter(row => row.status !== 'ok').length,
    unpricedTokens: metadata.filter(row => row.status === 'ok' && !row.priceUSD).map(row => row.label),
    providerRequests: results.length,
    providerQuoted: results.filter(row => row.status === 'quoted').length,
    providerNoQuote: results.filter(row => row.status === 'no_quote').length,
    providerErrors: results.filter(row => row.status === 'provider_error').length,
    unsafeResponses: results.filter(row => row.status === 'unsafe_response').length,
  };
  fs.writeFileSync(outputPath, JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), chainId: 10, block: Number(BigInt(blockTag)), tokenListTimestamp: tokenList.timestamp, tokenListUrl, priceUrl, summary,
    limitations: ['Deliberate representative basket, not a random sample or proof of most Optimism tokens.', 'Amounts are approximately $1/$10 using the recorded LI.FI price snapshot; prices may be stale or unavailable.', 'Quote availability does not prove token transferability, built-calldata execution, gas affordability, or future liquidity.', 'Public quote API requests are sequential and paced at least 275 ms apart. No transactions were signed or broadcast.'], metadata, results }, null, 2));
  return summary;
}

for (const token of tokens) {
  const row = { label: token.label, symbol: token.symbol, address: token.address, addressSource: token.addressSource, listedDecimals: token.decimals, listedName: token.name };
  try {
    const calls = await rpcBatch([
      ['eth_getCode', [token.address, blockTag]],
      ['eth_call', [{ to: token.address, data: '0x313ce567' }, blockTag]],
      ['eth_call', [{ to: token.address, data: '0x95d89b41' }, blockTag]],
      ['eth_call', [{ to: token.address, data: '0x06fdde03' }, blockTag]],
    ]);
    if (calls.some(call => call.error)) throw new Error(calls.filter(call => call.error).map(call => call.error.message).join('; '));
    if (!calls[0].result || calls[0].result === '0x') throw new Error('no bytecode');
    row.codeBytes = (calls[0].result.length - 2) / 2;
    row.decimals = Number(BigInt(calls[1].result));
    row.onchainSymbol = decodeString(calls[2].result);
    row.onchainName = decodeString(calls[3].result);
    if (row.decimals !== token.decimals) throw new Error('decimals mismatch');
    row.symbolMatchesList = row.onchainSymbol === token.symbol;
    const price = Number(prices.get(token.address.toLowerCase())?.priceUSD);
    row.priceUSD = Number.isFinite(price) && price > 0 ? prices.get(token.address.toLowerCase()).priceUSD : null;
    row.status = 'ok';
  } catch (error) { row.status = 'metadata_error'; row.error = error.message; }
  metadata.push(row);
  snapshot();
  console.log(`Metadata ${row.label}: ${row.status}, priceUSD=${row.priceUSD ?? 'unavailable'}`);
  if (row.status !== 'ok' || !row.priceUSD) continue;
  const toToken = token.address.toLowerCase() === USDC ? WETH : USDC;
  for (const usd of [1, 10]) {
    const amount = integerForUsd(usd, row.priceUSD, row.decimals);
    for (const provider of ['kyber', 'lifi']) {
      const measured = { token: row.label, tokenIn: token.address, tokenOut: toToken, requestedUsd: usd, inputPriceUSD: row.priceUSD, amountIn: amount, provider, timestamp: new Date().toISOString() };
      try {
        const url = provider === 'kyber'
          ? `https://aggregator-api.kyberswap.com/optimism/api/v1/routes?tokenIn=${token.address}&tokenOut=${toToken}&amountIn=${amount}`
          : `https://li.quest/v1/quote?fromChain=10&toChain=10&fromToken=${token.address}&toToken=${toToken}&fromAmount=${amount}&fromAddress=${taker}&toAddress=${taker}&slippage=0.05`;
        const reply = await request(url);
        measured.httpStatus = reply.status;
        const data = reply.body;
        const summary = provider === 'kyber' ? data.data?.routeSummary : data.estimate;
        const amountOut = provider === 'kyber' ? summary?.amountOut : summary?.toAmount;
        if (!reply.ok || !amountOut || BigInt(amountOut) <= 0n) {
          measured.status = reply.status === 429 || reply.status >= 500 ? 'provider_error' : 'no_quote';
          measured.error = (data.message || data.error || JSON.stringify(data)).toString().slice(0, 1500);
          measured.providerCode = data.code;
        } else {
          measured.amountOut = amountOut;
          measured.amountOutUsd = provider === 'kyber' ? summary.amountOutUsd : summary.toAmountUSD;
          measured.gasUsd = provider === 'kyber' ? summary.gasUsd : (summary.gasCosts || []).map(gas => gas.amountUSD);
          measured.target = provider === 'kyber' ? data.data.routerAddress : data.transactionRequest?.to;
          measured.spender = provider === 'kyber' ? data.data.routerAddress : summary.approvalAddress;
          measured.venues = provider === 'kyber'
            ? [...new Set((summary.route || []).flat().map(leg => leg.exchange).filter(Boolean))]
            : [...new Set((data.includedSteps || []).flatMap(step => [step.tool, step.toolDetails?.name]).filter(Boolean))];
          const expected = provider === 'kyber' ? kyberTarget : lifiTarget;
          const safeAddresses = measured.target?.toLowerCase() === expected && measured.spender?.toLowerCase() === expected;
          const safeChain = provider === 'kyber' || (data.action?.fromChainId === 10 && data.action?.toChainId === 10 && data.transactionRequest?.chainId === 10);
          const zeroValue = provider === 'kyber' || BigInt(data.transactionRequest?.value || '0') === 0n;
          measured.status = safeAddresses && safeChain && zeroValue ? 'quoted' : 'unsafe_response';
          if (provider === 'lifi') measured.builtCalldataBytes = Math.max(0, ((data.transactionRequest?.data || '0x').length - 2) / 2);
        }
      } catch (error) { measured.status = 'provider_error'; measured.error = error.message; }
      results.push(measured);
      snapshot();
      console.log(`${measured.token} $${usd} ${provider}: ${measured.status}${measured.venues ? ' via ' + measured.venues.join(', ') : ''}`);
    }
  }
}
console.log(JSON.stringify(snapshot(), null, 2));
console.log(`Saved read-only results: ${outputPath}`);
