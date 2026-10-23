// Publishes only public contract source, compiler settings and constructor arguments.
// Explorer credentials remain in memory and are sent only to the official Etherscan API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'apps/memefun-backend/package.json'));
const { encodeAbiParameters, parseAbiParameters } = require('viem');
const journalPath = path.join(root, 'packages/contracts/deployments/optimism/2026-10-14.json');
const inputPath = path.join(root, 'packages/contracts/out/optimism-verification-input.json');
// Use only a credential explicitly named for Etherscan from the contract deployment environment.
// Legacy BaseScan/other explorer keys must not be tested against a different service.
const envFiles = ['packages/contracts/.env'];
const keyNames = ['ETHERSCAN_API_KEY'];
const credentials = [];
const seen = new Set();
for (const file of envFiles) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) continue;
  const env = parseEnv(fs.readFileSync(absolute, 'utf8'));
  for (const name of keyNames) {
    const key = env[name]?.trim();
    if (key && !seen.has(key)) { credentials.push({ file, name, key }); seen.add(key); }
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = value => console.log(JSON.stringify(value));
const safe = value => {
  let text = String(value);
  for (const { key } of credentials) text = text.replaceAll(key, '[redacted]');
  return text.slice(0, 800);
};
async function etherscan(params, key, method = 'GET') {
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', '10');
  url.searchParams.set('apikey', key);
  const request = { signal: AbortSignal.timeout(45_000) };
  if (method === 'POST') {
    request.method = 'POST';
    request.body = new URLSearchParams(params);
  } else for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url, request);
  if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`);
  return response.json();
}
async function probe() {
  let accepted;
  for (const credential of credentials) {
    const result = await etherscan({ module: 'contract', action: 'getsourcecode', address: '0x4200000000000000000000000000000000000006' }, credential.key);
    const ok = result.status === '1' && Array.isArray(result.result) && !!result.result[0]?.SourceCode;
    log({ credential: `${credential.file}:${credential.name}`, accepted: ok, message: ok ? 'Public source API accepted credential' : safe(result.result ?? result.message) });
    if (ok) { accepted = credential; break; }
    await sleep(500);
  }
  return accepted;
}
async function main() {
  const credential = await probe();
  if (process.argv.includes('--probe')) return;
  if (!credential) { log({ etherscanVerified: false, reason: 'No available credential accepted by Etherscan V2' }); process.exitCode = 2; return; }
  if (!process.argv.includes('--submit')) throw new Error('Submission requires --submit');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  if (!journal.address || !journal.runtimeArtifactMatch) throw new Error('Deployment runtime must be verified first');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
  if (input.settings.evmVersion !== 'cancun' || input.settings.optimizer.runs !== 200 || input.settings.viaIR) throw new Error('Unexpected verification compiler settings');
  const source = fs.readFileSync(path.join(root, 'packages/contracts', journal.source), 'utf8');
  if (input.sources[journal.source]?.content !== source) throw new Error('Verification source differs from deployed source');
  const constructorArguments = encodeAbiParameters(parseAbiParameters('address,address,address,address,uint16'),
    [journal.permit2, journal.weth, journal.owner, journal.feeCollector, journal.feeBps]).slice(2);
  const published = await etherscan({ module: 'contract', action: 'getsourcecode', address: journal.address }, credential.key);
  let complete = published.status === '1' && !!published.result[0]?.SourceCode && published.result[0]?.ContractName === journal.contract;
  if (!complete) {
    const submission = await etherscan({ module: 'contract', action: 'verifysourcecode', contractaddress: journal.address,
      sourceCode: JSON.stringify(input), codeformat: 'solidity-standard-json-input',
      contractname: `${journal.source}:${journal.contract}`, compilerversion: `v${journal.compiler}`,
      optimizationUsed: '1', runs: '200', constructorArguments, evmversion: 'cancun', licenseType: '3' }, credential.key, 'POST');
    log({ submissionStatus: submission.status, message: safe(submission.result ?? submission.message) });
    if (submission.status !== '1') throw new Error(`Etherscan rejected verification: ${safe(submission.result)}`);
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(4000);
      const status = await etherscan({ module: 'contract', action: 'checkverifystatus', guid: submission.result }, credential.key);
      log({ verificationStatus: safe(status.result) });
      if (status.status === '1') { complete = true; break; }
      if (!/pending|queue/i.test(status.result)) throw new Error(`Verification failed: ${safe(status.result)}`);
    }
  }
  if (!complete) throw new Error('Etherscan verification did not complete within polling window');
  const result = await etherscan({ module: 'contract', action: 'getsourcecode', address: journal.address }, credential.key);
  const info = result.result?.[0];
  if (result.status !== '1' || !info?.SourceCode || info.ContractName !== journal.contract || info.CompilerVersion !== `v${journal.compiler}` || info.ConstructorArguments?.toLowerCase() !== constructorArguments.toLowerCase()) throw new Error('Published explorer metadata mismatch');
  journal.explorers = { ...journal.explorers, etherscan: { verified: true, url: `https://optimistic.etherscan.io/address/${journal.address}#code`, checkedAt: new Date().toISOString() } };
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
  log(journal.explorers.etherscan);
}
main().catch(error => { console.error(safe(error?.message ?? 'Explorer verification error')); process.exitCode = 1; });
