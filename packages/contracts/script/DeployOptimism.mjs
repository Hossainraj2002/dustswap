// User-authorized OP Mainnet deployment. Secrets are read in memory and never written to the journal.
// Run preflight first; deploy/configure additionally require --broadcast.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'apps/memefun-backend/package.json'));
const { createPublicClient, createWalletClient, http, encodeDeployData, encodeFunctionData,
  getContractAddress, keccak256, formatEther, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { optimism } = require('viem/chains');

const OWNER = '0xF113b1dBd848F44684f8543CcDf63C90f9535F57';
const COLLECTOR = '0xE09495e955794708D4bC28045C46891cAf643733';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const WETH = '0x4200000000000000000000000000000000000006';
const TARGETS = {
  UniswapV3: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  UniswapV2: '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2',
  VelodromeV2: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
  Kyber: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  LiFi: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
};
const SOURCE = 'remix/DustSwapSweepRouter_Optimism_Remix.sol';
const CONTRACT = 'DustSwapSweepRouterOptimism';
const artifactPath = path.join(root, 'packages/contracts/out/DustSwapSweepRouter_Optimism_Remix.sol', `${CONTRACT}.json`);
const journalPath = path.join(root, 'packages/contracts/deployments/optimism/2026-10-14.json');
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
const settings = metadata.settings;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(metadata.compiler.version === '0.8.24+commit.e11b9ed9', 'Unexpected compiler');
assert(settings.evmVersion === 'cancun' && !settings.viaIR, 'Unexpected EVM/viaIR settings');
assert(settings.optimizer.enabled && settings.optimizer.runs === 200, 'Unexpected optimizer settings');
assert(settings.compilationTarget[SOURCE] === CONTRACT, 'Unexpected compilation target');
const sourceBytes = fs.readFileSync(path.join(root, 'packages/contracts', SOURCE));
const sourceHash = keccak256(`0x${sourceBytes.toString('hex')}`);
assert(metadata.sources[SOURCE].keccak256 === sourceHash, 'Source differs from compiled artifact');
const constructorArgs = [PERMIT2, WETH, OWNER, COLLECTOR, 200];
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: constructorArgs });
const publicClient = createPublicClient({ chain: optimism, transport: http('https://mainnet.optimism.io', { timeout: 30_000, retryCount: 2 }) });
const stringify = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
let journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : {
  chainId: 10, source: SOURCE, contract: CONTRACT, compiler: metadata.compiler.version,
  evmVersion: 'cancun', optimizerRuns: 200, viaIR: false, owner: OWNER,
  feeCollector: COLLECTOR, feeBps: 200, permit2: PERMIT2, weth: WETH,
  sourceHash, creationBytecodeHash: keccak256(artifact.bytecode.object), transactions: [],
};
assert(journal.sourceHash === sourceHash && journal.creationBytecodeHash === keccak256(artifact.bytecode.object), 'Artifact changed since journal creation');
assert(journal.owner === OWNER && journal.feeCollector === COLLECTOR && journal.feeBps === 200, 'Journal settings mismatch');
const save = () => {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  journal.updatedAt = new Date().toISOString();
  fs.writeFileSync(`${journalPath}.tmp`, stringify(journal) + '\n');
  fs.renameSync(`${journalPath}.tmp`, journalPath);
};
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const read = (address, functionName, args = []) => publicClient.readContract({ address, abi: artifact.abi, functionName, args });

async function checkChain() {
  assert(await publicClient.getChainId() === 10, 'Refusing non-Optimism chain');
}
async function checkRouter() {
  assert(journal.address, 'Deploy router first');
  const code = await publicClient.getCode({ address: journal.address });
  assert(code && code.length === artifact.deployedBytecode.object.length, 'Runtime code size mismatch');
  const immutableNames = {};
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.nodeType === 'VariableDeclaration' && value.mutability === 'immutable') immutableNames[value.id] = value.name;
    for (const child of Object.values(value)) visit(child);
  };
  visit(artifact.ast);
  const expected = artifact.deployedBytecode.object.slice(2).split('');
  for (const [id, refs] of Object.entries(artifact.deployedBytecode.immutableReferences)) {
    const address = { permit2: PERMIT2, weth: WETH }[immutableNames[id]];
    assert(address, 'Unrecognized artifact immutable');
    for (const { start, length } of refs) expected.splice(start * 2, length * 2, ...address.slice(2).toLowerCase().padStart(length * 2, '0'));
  }
  assert(code.toLowerCase() === `0x${expected.join('')}`.toLowerCase(), 'Deployed runtime differs from exact artifact');
  for (const [name, expected] of [['owner', OWNER], ['feeCollector', COLLECTOR], ['permit2', PERMIT2], ['weth', WETH]]) {
    assert(same(await read(journal.address, name), expected), `${name} mismatch`);
  }
  assert(await read(journal.address, 'feeBps') === 200, 'Fee mismatch');
  assert(await read(journal.address, 'paused') === false, 'Router paused');
  journal.runtimeCodeHash = keccak256(code);
  journal.runtimeArtifactMatch = true;
  return code;
}
function signer() {
  const env = parseEnv(fs.readFileSync(path.join(root, 'apps/memefun-backend/.env.local'), 'utf8'));
  const raw = (env.KEEPER_PRIVATE_KEY ?? '').trim().replace(/^0x/, '');
  assert(/^[0-9a-fA-F]{64}$/.test(raw), 'MemeFun deployment key missing or invalid');
  const account = privateKeyToAccount(`0x${raw}`);
  assert(same(account.address, OWNER), 'MemeFun key address mismatch');
  return createWalletClient({ account, chain: optimism, transport: http('https://mainnet.optimism.io', { timeout: 30_000, retryCount: 0 }) });
}
async function confirm(entry) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: entry.hash, confirmations: 2, timeout: 180_000 });
  entry.status = receipt.status;
  entry.blockNumber = receipt.blockNumber.toString();
  entry.gasUsed = receipt.gasUsed.toString();
  entry.effectiveGasPrice = receipt.effectiveGasPrice.toString();
  if (receipt.l1Fee != null) entry.l1Fee = receipt.l1Fee.toString();
  if (receipt.contractAddress) journal.address = receipt.contractAddress;
  save();
  assert(receipt.status === 'success', `${entry.label} reverted; stopping`);
  console.log(stringify({ label: entry.label, hash: entry.hash, blockNumber: entry.blockNumber, status: entry.status, address: receipt.contractAddress ?? undefined }));
}
async function send(wallet, request, label) {
  // Persist the signed transaction's hash BEFORE broadcasting. A dropped network response must
  // never cause a second deployment or a duplicate configuration transaction on restart.
  const prepared = await wallet.prepareTransactionRequest({ ...request, account: wallet.account, chain: optimism });
  const serialized = await wallet.signTransaction(prepared);
  const l1Fee = await publicClient.readContract({
    address: '0x420000000000000000000000000000000000000F',
    abi: parseAbi(['function getL1Fee(bytes) view returns (uint256)']),
    functionName: 'getL1Fee', args: [serialized],
  });
  // Leave a separate reserve for OP operator fees and changes in L1 data pricing.
  const budget = prepared.gas * prepared.maxFeePerGas + l1Fee * 2n + 10_000_000_000_000n;
  assert(await publicClient.getBalance({ address: OWNER }) > budget, 'Insufficient balance including L1 data/operator-fee reserve');
  const hash = keccak256(serialized);
  const entry = { label, hash, nonce: prepared.nonce, status: 'pending', gasLimit: prepared.gas.toString(), l1FeeEstimate: l1Fee.toString() };
  journal.transactions.push(entry);
  save();
  const returnedHash = await publicClient.sendRawTransaction({ serializedTransaction: serialized });
  assert(returnedHash === hash, 'Broadcast transaction hash mismatch');
  await confirm(entry);
}
async function preflight() {
  await checkChain();
  const balance = await publicClient.getBalance({ address: OWNER });
  const nonce = await publicClient.getTransactionCount({ address: OWNER, blockTag: 'pending' });
  const gas = await publicClient.estimateGas({ account: OWNER, data, value: 0n });
  const fees = await publicClient.estimateFeesPerGas();
  const gasWithMargin = gas * 120n / 100n;
  const executionBudget = (gasWithMargin + 10n * 100_000n) * fees.maxFeePerGas;
  assert(balance > executionBudget, 'Funded balance below conservative execution gas budget');
  for (const [name, address] of Object.entries({ Permit2: PERMIT2, WETH, ...TARGETS })) {
    assert((await publicClient.getCode({ address }))?.length > 2, `${name} has no contract code`);
  }
  console.log(stringify({ chainId: 10, owner: OWNER, feeCollector: COLLECTOR, feeBps: 200,
    balanceEth: formatEther(balance), pendingNonce: nonce,
    expectedAddress: getContractAddress({ from: OWNER, nonce: BigInt(nonce) }),
    deploymentGasEstimate: gas, deploymentGasLimit: gasWithMargin, maxFeePerGas: fees.maxFeePerGas,
    executionBudgetEth: formatEther(executionBudget), note: 'Execution budget excludes OP L1-data/operator fees; recheck affordability before sending.',
    sourceHash, creationBytecodeHash: journal.creationBytecodeHash }));
  return gasWithMargin;
}
async function main() {
  const mode = process.argv[2] ?? 'preflight';
  assert(['preflight', 'deploy', 'configure', 'check'].includes(mode), 'Unknown mode');
  if (mode === 'preflight') { await preflight(); return; }
  await checkChain();
  if (mode === 'check') {
    await checkRouter();
    const allowlists = {};
    for (const [name, address] of Object.entries(TARGETS)) {
      allowlists[name] = { target: await read(journal.address, 'allowedTargets', [address]), spender: await read(journal.address, 'allowedSpenders', [address]) };
      assert(allowlists[name].target && allowlists[name].spender, `${name} allowlist incomplete`);
    }
    journal.configurationVerified = true;
    save();
    console.log(stringify({ address: journal.address, owner: OWNER, feeCollector: COLLECTOR, feeBps: 200, runtimeArtifactMatch: true, allowlists }));
    return;
  }
  assert(process.argv.includes('--broadcast'), 'Write modes require explicit --broadcast');
  for (const entry of journal.transactions.filter(tx => tx.status === 'pending')) await confirm(entry);
  if (mode === 'deploy') {
    if (journal.address) { await checkRouter(); console.log(`Already deployed: ${journal.address}`); return; }
    assert(!journal.transactions.some(tx => tx.label === 'deploy'), 'Deployment transaction already recorded; resolve it before another deployment');
    const gas = await preflight();
    await send(signer(), { data, gas, value: 0n }, 'deploy');
    await checkRouter();
    save();
    return;
  }
  await checkRouter();
  const wallet = signer();
  for (const [name, address] of Object.entries(TARGETS)) {
    for (const [getter, setter, role] of [['allowedTargets', 'setAllowedTarget', 'target'], ['allowedSpenders', 'setAllowedSpender', 'spender']]) {
      if (await read(journal.address, getter, [address])) continue;
      const args = [address, true];
      await publicClient.simulateContract({ account: OWNER, address: journal.address, abi: artifact.abi, functionName: setter, args });
      await send(wallet, { to: journal.address, data: encodeFunctionData({ abi: artifact.abi, functionName: setter, args }), value: 0n }, `${name} ${role}`);
    }
  }
  journal.configurationCompletedAt = new Date().toISOString();
  save();
}
main().catch(error => {
  // Never print transaction objects, serialized transactions or environment contents on errors.
  const message = String(error?.shortMessage ?? error?.message ?? 'Unknown deployment error').replace(/0x[0-9a-fA-F]{64,}/g, '[redacted]');
  console.error(message.slice(0, 1000));
  process.exitCode = 1;
});
