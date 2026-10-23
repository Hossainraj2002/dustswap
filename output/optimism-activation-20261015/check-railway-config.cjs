// Credentials stay in memory; only public settings and RPC health reach stdout/disk.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

async function rpc(url, method, params) {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && !data.error && data.result !== undefined,
      httpStatus: response.status, rpcErrorCode: data.error?.code ?? null,
      chainId: method === 'eth_chainId' ? data.result ?? null : undefined,
      tokenCount: Array.isArray(data.result?.tokenBalances) ? data.result.tokenBalances.length : undefined };
  } catch { return { ok: false, transportError: true }; }
}

(async () => {
  let values;
  try {
    const raw = execFileSync(process.execPath, [
      'C:/Users/akbar/Tools/node-v22.22.3-win-x64/node_modules/@railway/cli/bin/railway.js',
      'variable', 'list', '--project', '4c2226a1-f05a-47fa-aa42-a08c40339da5',
      '--environment', '5b785117-4db8-4a97-af39-48fb40a3e187',
      '--service', '639e1095-b77b-4ef8-a733-c797588b6761', '--json',
    ], { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    values = JSON.parse(raw);
  } catch { console.log(JSON.stringify({ railwayValuesReadable: false })); return; }
  const publicNames = [
    'DUST_SWEEP_ENABLED_CHAIN_IDS', 'DUST_SWEEP_ENABLE_AGGREGATORS',
    'DUST_SWEEP_ROUTER_V3_ADDRESS_10', 'DUST_SWEEP_FEE_BPS_10',
    'DUST_SWEEP_ROUTE_MAX_CAP_10', 'DUST_SWEEP_MIN_VALUE_USD_10',
    'DUST_SWEEP_WETH_PASSTHROUGH_10', 'DUST_SWEEP_ENABLE_KYBER_10',
    'DUST_SWEEP_ENABLE_LIFI_10', 'DUST_SWEEP_ENABLE_ZEROX_10',
    'DUST_SWEEP_ENABLE_OPENOCEAN_10', 'DUST_SWEEP_ALLOWED_AGGREGATOR_TARGETS_10',
    'DUST_SWEEP_NATIVE_QUOTE_BUDGET_MS_10', 'OPTIMISM_RPC_URL', 'OPTIMISM_RPC_PUBLIC_FALLBACK',
  ];
  const settings = Object.fromEntries(publicNames.map(name => [name, values[name] ?? null]));
  const baseKeys = String(values.ALCHEMY_BASE_RPC_KEYS || '').split(/[\s,]+/).filter(Boolean);
  const opKeys = String(values.ALCHEMY_OPTIMISM_RPC_KEYS || '').split(/[\s,]+/).filter(Boolean);
  const referenceResolved = opKeys.length > 0 && !opKeys.some(key => key.includes('${{'));
  const report = { checkedAt: new Date().toISOString(), railwayValuesReadable: true, settings,
    alchemy: { baseKeyCount: baseKeys.length, opKeyCount: opKeys.length,
      referenceResolved, matchesBasePool: referenceResolved && opKeys.join(',') === baseKeys.join(',') } };
  if (referenceResolved) {
    report.alchemy.keyHealth = await Promise.all(opKeys.map(async (key, index) => {
      const url = `https://opt-mainnet.g.alchemy.com/v2/${encodeURIComponent(key)}`;
      const chain = await rpc(url, 'eth_chainId', []);
      const balances = chain.ok && chain.chainId === '0xa'
        ? await rpc(url, 'alchemy_getTokenBalances', ['0xF113b1dBd848F44684f8543CcDf63C90f9535F57', 'erc20']) : null;
      return { index: index + 1, chain, tokenBalances: balances };
    }));
  }
  report.publicRpc = await rpc('https://mainnet.optimism.io', 'eth_chainId', []);
  try {
    const response = await fetch('https://dustswap-production.up.railway.app/api/dustsweep/tokens?chainId=10&address=0xF113b1dBd848F44684f8543CcDf63C90f9535F57', {
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json();
    report.runningApi = { httpStatus: response.status, code: data.code ?? data.error?.code ?? null,
      enabledChains: data.enabledChains ?? data.error?.enabledChains ?? null,
      optimismEnabled: response.ok };
  } catch { report.runningApi = { checkFailed: true }; }
  fs.writeFileSync(path.join(__dirname, 'railway-config-health.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(() => { console.log(JSON.stringify({ checkFailed: true })); process.exitCode = 1; });
