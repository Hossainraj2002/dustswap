/** Bounded, opt-in Base QA. Default only reads; --broadcast creates four permanent QA coins.
 * Run: pnpm exec tsx scripts/mainnet-smoke.ts [--broadcast [--resume data/mainnet-smoke/<journal>.jsonl]]
 * Resume is deliberately limited to the reconciled Creator-launch/ETH-buy stage.
 */
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  type Abi, type Address, type Hex, type TransactionReceipt, BaseError, ContractFunctionRevertedError,
  createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData, erc20Abi, fallback, getAddress, http,
  keccak256, parseEther, parseEventLogs, zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { estimateL1Fee } from "viem/op-stack";
import { createSiweMessage } from "viem/siwe";

import { DATA_SUFFIX, BUILDER_CODE } from "../keeper/builderCode";
import { loadDeployment } from "../lib/deployment";
import { COIN_SUPPLY, DEAD_ADDRESS } from "../shared/core/constants";
import { launchPoolAt, minOut, quoteBuy, startTickExact } from "../shared/core/pool";
import { buybackBurnVaultAbi, feeVaultAbi, floorVaultAbi, memeFunConfigAbi, memeFunFactoryAbi, memeFunHookAbi, memeFunRouterAbi } from "../shared/abis";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://memefun-api-production.up.railway.app";
const ORIGIN = "https://memefun.dustswap.wtf";
const EXPECTED_OWNER = getAddress("0xF113b1dBd848F44684f8543CcDf63C90f9535F57");
// Includes the reconciled earlier approval/reset gas within the user's aggregate 0.0008 cap.
const SPEND_CAP = parseEther("0.000798");
const RESERVE = parseEther("0.0006");
const B_FUND = parseEther("0.00006");
const FIRST_USDC = 5_000n;
const L1_BUFFER = parseEther("0.000001");
const CLEANUP_HEADROOM = parseEther("0.000025");
const L1_BLOCK = "0x4200000000000000000000000000000000000015" as const;
const OPERATOR_ABI = [
  { type: "function", name: "operatorFeeScalar", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "operatorFeeConstant", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
] as const;
const broadcast = process.argv.includes("--broadcast");
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function safeError(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk(e => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return revert.data.errorName;
  }
  const message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : "Unknown failure";
  return message.replace(/https?:\/\/\S+/gi, "[endpoint]").replace(/0x[0-9a-f]{64,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "[session]").replace(/[\r\n]+/g, " ").slice(0, 180);
}
interface Call { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint }
interface Terms { creationFee: bigint; feeMinBps: number; feeMaxBps: number; creatorKeepMaxBps: number; protectionDurationSec: number; launchesPaused: boolean }
interface PoolConfig { coin: Address; mode: number; feeBps: number; creatorKeepBps: number; launchedAt: number; protectionDurationSec: number; seeded: boolean }
interface MarketEvent { coin: Address; quote: Address; poolId: Hex; allocation: bigint; record: { firstBuyCoins: bigint; firstBuyQuote: bigint; feeBps: bigint; protectionDurationSec: bigint } }
interface CoinInfo { address: Address; creator: Address; markets: Array<{ poolId: Hex; quote: { address: Address } }>; [key: string]: unknown }
interface JournalStep { label: string; status: string; [key: string]: unknown }
interface Journal { runId: string; chainId: number; broadcast: boolean; walletA?: Address; walletB?: Address; builderCode: string; limits: object; spentWei: bigint; steps: JournalStep[]; coins: Array<{ mode: string; coin: Address; markets: MarketEvent[] }>; status: string; [key: string]: unknown }
interface ResumeState { parentRunId: string; parentPath: string; spent: bigint; creator: { mode: string; coin: Address; markets: MarketEvent[] }; ethBuyOutput: bigint; ethBuyReceipt: TransactionReceipt; originalFactoryAllowance: bigint; reconciled: Array<{ label: string; hash: Hex; nonce: number; blockNumber: bigint; gasPaid: bigint; value: bigint }> }

async function main() {
  const args = process.argv.slice(2);
  let resumeArgument: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--broadcast") continue;
    check(args[i] === "--resume" && !resumeArgument && Boolean(args[i + 1]), "Only --broadcast and one --resume journal path are accepted");
    resumeArgument = args[++i];
  }
  check(!resumeArgument || broadcast, "--resume requires explicit --broadcast");
  // Read only this explicit file, in memory; do not load it into process.env or log it.
  const env = parseEnv(readFileSync(resolve(ROOT, ".env.mainnet.local"), "utf8"));
  const key = env.KEEPER_PRIVATE_KEY?.trim();
  check(key && /^0x[0-9a-f]{64}$/i.test(key), "Missing or invalid KEEPER_PRIVATE_KEY");
  check(env.MEMEFUN_CHAIN === "base", "Mainnet env must explicitly select base");
  for (const name of ["MEMEFUN_BUILDER_CODE", "BUILDER_CODE", "BASE_BUILDER_CODE"]) check(!env[name] || env[name] === BUILDER_CODE, "Builder-code alias mismatch");
  const urls = (env.MEMEFUN_RPC_URLS ?? "").split(/[,\s]+/).filter(Boolean);
  check(urls.length > 0 && urls.every(url => new URL(url).protocol === "https:"), "Paid HTTPS RPC URLs required");
  check(urls.every(url => !/mainnet\.base\.org/i.test(url)), "Public Base RPC refused");
  const transport = fallback(urls.map(url => http(url, { retryCount: 0, timeout: 20_000 })), { retryCount: 1 });
  const client = createPublicClient({ chain: base, transport });
  const readProviders = urls.map(url => createPublicClient({ chain: base, transport: http(url, { retryCount: 0, timeout: 15_000 }) }));
  let lastConfirmedReadBlock: bigint | undefined;
  async function freshnessBarrier(minimumBlock: bigint) {
    const target = lastConfirmedReadBlock !== undefined && lastConfirmedReadBlock > minimumBlock ? lastConfirmedReadBlock : minimumBlock;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const heads = await Promise.all(readProviders.map(provider => provider.getBlockNumber({ cacheTime: 0 }).catch(() => null)));
      if (heads.every(head => head !== null && head >= target)) { lastConfirmedReadBlock = target; return; }
      await new Promise(r => setTimeout(r, 2_000));
    }
    throw new Error("Configured read providers did not all reach the required confirmed block");
  }
  const feeOf = (receipt: TransactionReceipt) => {
    const l1 = (receipt as TransactionReceipt & { l1Fee?: bigint | null }).l1Fee;
    check(l1 !== undefined && l1 !== null, "Canonical receipt lacks L1 fee");
    return receipt.gasUsed * receipt.effectiveGasPrice + l1;
  };
  async function canonicalReceipt(hash: Hex, blockNumber: bigint) {
    await freshnessBarrier(blockNumber + 2n);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const results = await Promise.all(readProviders.map(provider => provider.getTransactionReceipt({ hash }).catch(() => null)));
      const first = results[0];
      if (first && first.transactionHash === hash && first.blockNumber === blockNumber && results.every(receipt => receipt && receipt.transactionHash === hash && receipt.blockHash === first.blockHash && receipt.status === first.status && receipt.gasUsed === first.gasUsed && receipt.effectiveGasPrice === first.effectiveGasPrice && (receipt as TransactionReceipt & { l1Fee?: bigint | null }).l1Fee === (first as TransactionReceipt & { l1Fee?: bigint | null }).l1Fee)) {
        feeOf(first); return first;
      }
      await new Promise(r => setTimeout(r, 2_000));
    }
    throw new Error("Configured read providers did not agree on canonical receipt fees");
  }
  // A submission gets one attempt at one endpoint. Receipt recovery only queries known hashes.
  const submitClient = createPublicClient({ chain: base, transport: http(urls[0]!, { retryCount: 0, timeout: 20_000 }) });
  const A = privateKeyToAccount(key as Hex);
  const secondary = `0x${createHmac("sha256", Buffer.from(key.slice(2), "hex")).update("memefun-mainnet-qa-secondary-v1").digest("hex")}` as Hex;
  const B = privateKeyToAccount(secondary);
  const wallet = (account: typeof A) => createWalletClient({ account, chain: base, transport });
  const d = loadDeployment(8453);
  check(same(d.owner, EXPECTED_OWNER) && same(A.address, EXPECTED_OWNER), "Signer must equal expected deployment owner");
  check(await client.getChainId() === 8453, "RPC chain mismatch");
  await freshnessBarrier((await client.getBlockNumber({ cacheTime: 0 })) + 2n);
  // Explicit block numbers prevent fallback endpoints from silently serving pre-receipt state.
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args, blockNumber: lastConfirmedReadBlock } as never) as Promise<T>;
  const requireZeroOperatorFee = async () => {
    // Viem's convenience estimator catches every RPC error and returns zero. Read directly so
    // unavailable fee parameters stop the run rather than silently undercounting its budget.
    const [scalar, constant] = await Promise.all([
      read<number>(L1_BLOCK, OPERATOR_ABI, "operatorFeeScalar"),
      read<bigint>(L1_BLOCK, OPERATOR_ABI, "operatorFeeConstant"),
    ]);
    check(Number(scalar) === 0 && constant === 0n, "Nonzero operator fees require explicit budget support");
  };
  await requireZeroOperatorFee();
  check(same(await read<Address>(d.config, memeFunConfigAbi, "owner"), EXPECTED_OWNER), "Onchain owner mismatch");
  const terms = await read<Terms>(d.config, memeFunConfigAbi, "launchTerms");
  check(same(await read<Address>(d.config, memeFunConfigAbi, "treasury"), A.address), "Platform claims require the configured treasury to equal A");
  check(!terms.launchesPaused && terms.feeMinBps <= 500 && terms.feeMaxBps >= 500 && terms.creatorKeepMaxBps >= 2500, "QA launch terms unavailable");
  for (let mode = 0; mode < 4; mode++) check((await read<{ enabled: boolean }>(d.config, memeFunConfigAbi, "modeInfo", [mode])).enabled, "QA mode disabled");
  let resume: ResumeState | undefined;
  if (resumeArgument) {
    const parentPath = realpathSync(resolve(ROOT, resumeArgument));
    const inside = relative(resolve(ROOT, "data/mainnet-smoke"), parentPath);
    check(!inside.startsWith("..") && !inside.includes(":") && parentPath.endsWith(".jsonl"), "Resume must reference a public mainnet-smoke JSONL journal");
    const lines = readFileSync(parentPath, "utf8").trim().split(/\r?\n/);
    const prior = JSON.parse(lines[lines.length - 1]!) as Journal;
    check(prior.chainId === 8453 && prior.broadcast && prior.walletA && same(prior.walletA, A.address) && prior.walletB && same(prior.walletB, B.address) && prior.builderCode === BUILDER_CODE, "Resume journal identity mismatch");
    check(prior.status === "failed-stop-do-not-rerun" && prior.error === "Trade quote delta mismatch", "Only the supported Creator ETH-buy assertion failure can resume");
    check(prior.coins.length === 1 && prior.coins[0]?.mode === "creator", "Unsupported resume coin stage");
    const transactions = prior.steps.filter(step => step.hash !== undefined);
    const labels = ["approve-exact-finite", "launch-Creator", "buy-eth", "restore-original-allowance"];
    check(transactions.length === 4 && transactions.every((step, i) => step.status === "success" && step.label === labels[i]), "Resume refuses missing, uncertain or extra transaction steps");
    const baseline = prior.steps.filter(step => step.label === "allowance-baseline");
    check(baseline.length === 1 && same(String(baseline[0]!.owner), A.address) && same(String(baseline[0]!.token), d.usdc) && same(String(baseline[0]!.spender), d.factory) && BigInt(String(baseline[0]!.amount)) === 0n, "Unsupported original allowance baseline");
    let spent = 0n;
    let markets: MarketEvent[] = [];
    let ethBuyOutput = 0n;
    let ethBuyReceipt: TransactionReceipt | undefined;
    const reconciled: ResumeState["reconciled"] = [];
    for (const [i, step] of transactions.entries()) {
      check(typeof step.hash === "string" && /^0x[0-9a-f]{64}$/i.test(step.hash), "Invalid public transaction hash");
      const hash = step.hash as Hex;
      const tx = await client.getTransaction({ hash });
      check(tx.blockNumber !== null && same(tx.from, A.address) && tx.to && tx.type === "eip1559" && tx.chainId === 8453 && tx.nonce === Number(step.nonce) && tx.value === BigInt(String(step.value)) && same(tx.to, String(step.to)) && tx.input.endsWith(DATA_SUFFIX.slice(2)), "Resume transaction identity/calldata mismatch");
      if (i > 0) check(tx.nonce === reconciled[i - 1]!.nonce + 1, "Resume transaction nonces are not contiguous");
      const receipt = await canonicalReceipt(hash, tx.blockNumber);
      check(receipt.status === "success" && receipt.blockNumber === BigInt(String(step.blockNumber)), "Resume receipt mismatch");
      const input = tx.input.slice(0, -(DATA_SUFFIX.length - 2)) as Hex;
      if (i === 0 || i === 3) {
        check(same(tx.to, d.usdc) && tx.value === 0n, "Resume approval target mismatch");
        const decoded = decodeFunctionData({ abi: erc20Abi, data: input });
        check(decoded.functionName === "approve" && same(String(decoded.args[0]), d.factory) && BigInt(String(decoded.args[1])) === (i === 0 ? 20_000n : 0n), "Resume approval arguments mismatch");
      } else if (i === 1) {
        check(same(tx.to, d.factory) && tx.value === parseEther("0.00002"), "Resume launch target/value mismatch");
        const decoded = decodeFunctionData({ abi: memeFunFactoryAbi, data: input });
        check(decoded.functionName === "launchMulti", "Resume launch function mismatch");
        const [params, pairs] = decoded.args;
        check(params.name.startsWith("QA TEST Creator ") && params.symbol.startsWith("QAC") && Number(params.mode) === 0 && Number(params.feeBps) === 500 && Number(params.creatorKeepBps) === 0 && params.quote === zeroAddress && params.firstBuyAmount === parseEther("0.00002") && pairs.length === 2 && pairs[0]!.quote === zeroAddress && pairs[0]!.firstBuyAmount === parseEther("0.00002") && same(pairs[1]!.quote, d.usdc) && pairs[1]!.firstBuyAmount === 5_000n, "Resume launch arguments mismatch");
        markets = parseEventLogs({ abi: memeFunFactoryAbi, eventName: "MarketLaunched", logs: receipt.logs }).filter(e => same(e.address, d.factory)).map(e => e.args as unknown as MarketEvent);
        check(markets.length === 2 && markets.every(m => same(m.coin, prior.coins[0]!.coin)), "Resume launch event mismatch");
        check(same(await read<Address>(d.factory, memeFunFactoryAbi, "predictCoin", [A.address, params.salt]), prior.coins[0]!.coin), "Resume coin prediction mismatch");
      } else {
        check(same(tx.to, d.router) && tx.value === parseEther("0.000001"), "Resume ETH buy target/value mismatch");
        const decoded = decodeFunctionData({ abi: memeFunRouterAbi, data: input });
        check(decoded.functionName === "buyFor", "Resume buy function mismatch");
        const [params, quote] = decoded.args;
        check(same(params.coin, prior.coins[0]!.coin) && quote === zeroAddress && params.amountIn === tx.value && params.recipient === zeroAddress && params.referrer === zeroAddress, "Resume buy arguments mismatch");
        const trades = parseEventLogs({ abi: memeFunHookAbi, eventName: "Trade", logs: receipt.logs }).filter(e => same(e.address, d.hook));
        check(trades.length === 1 && trades[0]!.args.isBuy && same(trades[0]!.args.trader, A.address) && same(trades[0]!.args.id, markets.find(m => m.quote === zeroAddress)!.poolId), "Resume ETH buy event mismatch");
        ethBuyOutput = trades[0]!.args.coinAmount;
        ethBuyReceipt = receipt;
      }
      const gasPaid = feeOf(receipt);
      spent += tx.value + gasPaid;
      reconciled.push({ label: step.label, hash, nonce: tx.nonce, blockNumber: receipt.blockNumber, gasPaid, value: tx.value });
    }
    check(ethBuyReceipt && ethBuyOutput > 0n && markets.length === 2, "Resume state incomplete");
    check(await client.getTransactionCount({ address: A.address, blockTag: "latest" }) === reconciled[3]!.nonce + 1, "A has unexpected later transactions; resume refused");
    check(await read<bigint>(d.usdc, erc20Abi, "allowance", [A.address, d.factory]) === 0n, "Prior factory allowance cleanup not reconciled");
    check(await client.getBalance({ address: B.address }) === 0n && await client.getTransactionCount({ address: B.address, blockTag: "latest" }) === 0, "Unsupported funded/used secondary stage");
    resume = { parentRunId: prior.runId, parentPath, spent, creator: { mode: "creator", coin: prior.coins[0]!.coin, markets }, ethBuyOutput, ethBuyReceipt, originalFactoryAllowance: 0n, reconciled };
  }
  const aStart = await client.getBalance({ address: A.address });
  const bStart = await client.getBalance({ address: B.address });
  const expectedNonces = new Map<Address, number>();
  for (const account of [A, B]) {
    const latest = await client.getTransactionCount({ address: account.address, blockTag: "latest" });
    check(latest === await client.getTransactionCount({ address: account.address, blockTag: "pending" }), "Signer has pending transactions");
    expectedNonces.set(account.address, latest);
  }
  check(await read<bigint>(d.feeVault, feeVaultAbi, "referralPending", [B.address, zeroAddress]) === 0n, "Secondary already has referral earnings; refusing aggregate claim");
  const usdcStart = await read<bigint>(d.usdc, erc20Abi, "balanceOf", [A.address]);
  const carriedSpend = resume?.spent ?? 0n;
  check(carriedSpend < SPEND_CAP && aStart >= RESERVE + SPEND_CAP - carriedSpend, "Insufficient ETH for remaining cap and reserve");
  check(usdcStart >= 24_000n, "At least 0.024 USDC required for first buys and smoke buys");
  const plannedValue = terms.creationFee * (resume ? 3n : 4n) + parseEther(resume ? "0.00024" : "0.00026") + parseEther(resume ? "0.000004" : "0.000005") + B_FUND;
  check(carriedSpend + plannedValue + parseEther("0.00015") + CLEANUP_HEADROOM <= SPEND_CAP, "Planned values plus gas headroom exceed cap");
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
  const journalDir = resolve(ROOT, "data/mainnet-smoke");
  mkdirSync(journalDir, { recursive: true });
  const journalPath = resolve(journalDir, `${runId}.jsonl`);
  const journal: Journal = { runId, chainId: 8453, broadcast, walletA: A.address, walletB: B.address, builderCode: BUILDER_CODE,
    limits: { spendCapWei: SPEND_CAP, minimumAReserveWei: RESERVE, secondaryFundingWei: B_FUND, usdcFirstBuyRaw: FIRST_USDC },
    spentWei: carriedSpend, steps: [], coins: resume ? [resume.creator] : [], status: "planned", startingBalances: { eth: aStart, ethB: bStart, usdc: usdcStart }, outsideJournalGasReserveWei: parseEther("0.000002"), ...(resume ? { resumedFrom: { runId: resume.parentRunId, journal: resume.parentPath, reconciled: resume.reconciled } } : {}), checkpoints: {} };
  const save = () => appendFileSync(journalPath, JSON.stringify(journal, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value) + "\n", { flush: true });
  const record = (label: string, detail: object = {}) => { journal.steps.push({ label, status: "verified", ...detail }); save(); console.log(label); };
  const checkpoint = (key: string, detail: object) => { (journal.checkpoints as Record<string, unknown>)[key] = detail; save(); };
  let uncertain = false;
  let bFunded = false;
  const assetBalance = (owner: Address, quote: Address, blockNumber = lastConfirmedReadBlock) => quote === zeroAddress ? client.getBalance({ address: owner, blockNumber }) : client.readContract({ address: quote, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber });
  const tokenBalance = (token: Address, owner: Address, blockNumber: bigint) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber });
  const simulate = async <T>(account: typeof A, call: Call): Promise<{ result: T }> => {
    for (let attempt = 0; ; attempt++) {
      const moduleCall = call.functionName === "executeBuybackFor" || call.functionName === "addFloorFor";
      const block = moduleCall ? { blockTag: "pending" as const } : { blockNumber: lastConfirmedReadBlock };
      try { return await client.simulateContract({ account, ...call, args: call.args ?? [], ...block } as never) as unknown as { result: T }; }
      catch (error) {
        const message = safeError(error);
        const allowanceLag = /ERC20InsufficientAllowance|transfer amount exceeds allowance|ERC20.*allowance/i.test(message);
        if (!allowanceLag || attempt >= 2) throw error;
        // Only an eth_call is retried; no signed transaction is generated or resubmitted here.
        await freshnessBarrier((lastConfirmedReadBlock ?? await client.getBlockNumber({ cacheTime: 0 })) + 2n);
        record("read-only-allowance-preflight-retry", { attempt: attempt + 1, confirmedReadBlock: lastConfirmedReadBlock });
      }
    }
  };
  const reject = async (label: string, account: typeof A, call: Call, expected: string) => {
    let failure = "";
    try { await simulate(account, call); } catch (error) { failure = safeError(error); }
    check(failure === expected, `${label}: expected ${expected}, observed ${failure || "success"}`);
    record(label, { expectedRevert: expected });
  };
  async function sendRaw(label: string, account: typeof A, to: Address, value: bigint, input: Hex, cleanup = false, pendingSimulation = false): Promise<TransactionReceipt> {
    check(broadcast && !uncertain, "Broadcast disabled or previous submission uncertain");
    const data = `${input}${DATA_SUFFIX.slice(2)}` as Hex;
    check(data.endsWith(DATA_SUFFIX.slice(2)), "Missing transaction attribution");
    const fees = await client.estimateFeesPerGas();
    const block = pendingSimulation ? { blockTag: "pending" as const } : { blockNumber: lastConfirmedReadBlock };
    const gas = (await client.estimateGas({ account, to, data, value, ...block })) * 125n / 100n + 5_000n;
    const l1 = await estimateL1Fee(client, { account, to, data, value });
    await requireZeroOperatorFee();
    const gasBound = gas * fees.maxFeePerGas + l1 * 2n + L1_BUFFER;
    const countedValue = cleanup ? 0n : value;
    check(journal.spentWei + countedValue + gasBound + (cleanup ? 0n : CLEANUP_HEADROOM) <= SPEND_CAP, "Aggregate ETH value and gas cap reached");
    const balance = await client.getBalance({ address: account.address });
    check(balance >= value + gasBound + (same(account.address, A.address) ? RESERVE : 0n), "Minimum ETH reserve would be breached");
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
    check(nonce === expectedNonces.get(account.address), "Signer nonce changed outside this run");
    const signed = await wallet(account).signTransaction({ to, data, value, gas, nonce, ...fees, type: "eip1559" });
    const hash = keccak256(signed);
    const step: JournalStep = { label, status: "signed_not_submitted", from: account.address, to, value, gasBound, nonce, hash, cleanup };
    journal.steps.push(step); save();
    try {
      step.status = "submitting"; save();
      check(await submitClient.sendRawTransaction({ serializedTransaction: signed }) === hash, "Submission hash mismatch");
    } catch (error) {
      step.submissionError = safeError(error); step.status = "submission_uncertain"; save();
      // Never resend. Continue only if the exact pre-journalled hash has a confirmed receipt.
      const recovered = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (!recovered) { uncertain = true; throw new Error(`Uncertain submission: ${label}; reconcile journal hash before any further action`); }
    }
    let receipt: TransactionReceipt;
    try { receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000, confirmations: 1, checkReplacement: false }); }
    catch { uncertain = true; step.status = "receipt_uncertain"; save(); throw new Error(`Receipt uncertain: ${label}; reconcile journal hash`); }
    check(receipt.transactionHash === hash, "Receipt hash mismatch");
    expectedNonces.set(account.address, nonce + 1);
    const provisionalGas = receipt.gasUsed * receipt.effectiveGasPrice + l1 * 2n + L1_BUFFER;
    journal.spentWei += countedValue + provisionalGas;
    Object.assign(step, { status: receipt.status, blockNumber: receipt.blockNumber, gasPaid: provisionalGas, gasUsed: receipt.gasUsed, feeStatus: "provisional" }); save();
    check(receipt.status === "success", `Transaction reverted: ${label}`);
    check(journal.spentWei <= SPEND_CAP, "Confirmed spend exceeded cap");
    try {
      receipt = await canonicalReceipt(hash, receipt.blockNumber);
      const gasPaid = feeOf(receipt);
      journal.spentWei += gasPaid - provisionalGas;
      Object.assign(step, { confirmedReadBlock: lastConfirmedReadBlock, gasPaid, feeStatus: "canonical-agreed", l1Fee: (receipt as TransactionReceipt & { l1Fee?: bigint }).l1Fee }); save();
      check(journal.spentWei <= SPEND_CAP, "Canonical confirmed spend exceeded cap");
    }
    catch (error) { uncertain = true; step.providerFreshness = "unavailable-after-confirmed-receipt"; save(); throw error; }
    check(await client.getBalance({ address: A.address }) >= RESERVE, "Confirmed A balance below reserve");
    const tx = await client.getTransaction({ hash });
    check(tx.input.endsWith(DATA_SUFFIX.slice(2)), "Confirmed transaction missing attribution");
    console.log(`${label}: ${hash}`);
    return receipt;
  }
  async function send(label: string, account: typeof A, call: Call) {
    checkpoint(`call:${label}:${call.address}:${String(call.args?.[0] ?? "")}`, { status: "prepared", label, from: account.address, address: call.address, functionName: call.functionName, args: call.args ?? [], value: call.value ?? 0n });
    await simulate(account, call);
    const receipt = await sendRaw(label, account, call.address, call.value ?? 0n, encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] } as never), false, call.functionName === "executeBuybackFor" || call.functionName === "addFloorFor");
    checkpoint(`call:${label}:${call.address}:${String(call.args?.[0] ?? "")}`, { status: "confirmed", label, from: account.address, address: call.address, functionName: call.functionName, args: call.args ?? [], value: call.value ?? 0n, hash: receipt.transactionHash, blockNumber: receipt.blockNumber });
    return receipt;
  }
  const allowances = new Map<string, { account: typeof A; token: Address; spender: Address; baseline: bigint }>();
  if (resume) allowances.set(`${A.address}:${d.usdc}:${d.factory}`, { account: A, token: d.usdc, spender: d.factory, baseline: resume.originalFactoryAllowance });
  async function ensureAllowance(account: typeof A, token: Address, spender: Address, needed: bigint) {
    const id = `${account.address}:${token}:${spender}`;
    const current = await read<bigint>(token, erc20Abi, "allowance", [account.address, spender]);
    if (!allowances.has(id)) { allowances.set(id, { account, token, spender, baseline: current }); record("allowance-baseline", { owner: account.address, token, spender, amount: current }); }
    if (current < needed) await send("approve-exact-finite", account, { address: token, abi: erc20Abi, functionName: "approve", args: [spender, needed] });
  }
  async function restoreAllowances() {
    for (const item of allowances.values()) {
      const current = await read<bigint>(item.token, erc20Abi, "allowance", [item.account.address, item.spender]);
      if (current !== item.baseline) await send("restore-original-allowance", item.account, { address: item.token, abi: erc20Abi, functionName: "approve", args: [item.spender, item.baseline] });
    }
  }
  async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const response = await fetch(API + path, { ...init, headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(20_000) });
    check(response.ok, `API ${path.split("?")[0]} failed with HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }
  const post = <T>(path: string, body: unknown, token?: string) => api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: json(body) }, token);
  async function indexed(coin: Address): Promise<CoinInfo> {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const result = await api<{ coin: CoinInfo }>(`/v1/coins/${coin}`).catch(() => null);
      if (result?.coin.markets?.length === 2) return result.coin;
      await new Promise(r => setTimeout(r, 2_500));
    }
    throw new Error("Indexer did not expose the QA coin's two markets in time");
  }
  async function verifyCoin(coin: Address, mode: number, markets: MarketEvent[], expectedBalance?: bigint) {
    check(same(await read<Address>(d.hook, memeFunHookAbi, "creatorOf", [coin]), A.address), "Creator mismatch");
    check(await read<bigint>(coin, erc20Abi, "totalSupply") === COIN_SUPPLY, "Token supply mismatch");
    for (const market of markets) {
      const config = await read<PoolConfig>(d.hook, memeFunHookAbi, "configFor", [coin, market.quote]);
      check(config.seeded && Number(config.mode) === mode && Number(config.feeBps) === 500, "Market configuration mismatch");
      check(same(await read<Hex>(d.hook, memeFunHookAbi, "poolIdFor", [coin, market.quote]), market.poolId), "Pool ID mismatch");
      check(market.record.firstBuyCoins > 0n && market.record.firstBuyQuote > 0n, "First buy missing");
    }
    const chainBalance = await read<bigint>(coin, erc20Abi, "balanceOf", [A.address]);
    check(chainBalance === (expectedBalance ?? markets.reduce((sum, m) => sum + m.record.firstBuyCoins, 0n)), "Launch/resume token balance mismatch");
    const exposed = await indexed(coin);
    check(same(exposed.creator, A.address) && markets.every(m => exposed.markets.some(e => same(e.poolId, m.poolId) && same(e.quote.address, m.quote))), "API market identity mismatch");
    const balanceDto = await api<{ raw?: string; balance?: number }>(`/v1/coins/${coin}/balance/${A.address}`);
    if (balanceDto.raw !== undefined) check(BigInt(balanceDto.raw) === chainBalance, "API raw balance mismatch");
    else check(typeof balanceDto.balance === "number" && Math.abs(balanceDto.balance - Number(chainBalance) / 1e18) < Math.max(1e-6, Number(chainBalance) / 1e18 * 1e-9), "API balance mismatch");
    record("launch-state-and-api", { coin, mode, tokenBalance: chainBalance });
  }
  async function trade(account: typeof A, coin: Address, quote: Address, side: "buy" | "sell", amount: bigint, referrer: Address = zeroAddress) {
    const token = side === "buy" ? quote : coin;
    if (token !== zeroAddress) await ensureAllowance(account, token, d.router, amount);
    const deadline = (await client.getBlock()).timestamp + 300n;
    const params = { coin, amountIn: amount, minAmountOut: 0n, recipient: zeroAddress, referrer, deadline };
    const call: Call = { address: d.router, abi: memeFunRouterAbi, functionName: side === "buy" ? "buyFor" : "sellFor", args: [params, quote], value: side === "buy" && quote === zeroAddress ? amount : 0n };
    const quoted = (await simulate<bigint>(account, call)).result;
    check(quoted > 0n, "Trade quote has no output");
    call.args = [{ ...params, minAmountOut: minOut(quoted, 500) }, quote];
    const poolId = await read<Hex>(d.hook, memeFunHookAbi, "poolIdFor", [coin, quote]);
    checkpoint(`trade:${coin}:${quote}:${side}`, { status: "prepared", account: account.address, coin, quote, side, amount, referrer });
    const receipt = await send(`${side}-${quote === zeroAddress ? "eth" : "usdc"}`, account, call);
    return verifyTrade(receipt, account, coin, quote, side, amount, poolId);
  }
  async function verifyTrade(receipt: TransactionReceipt, account: typeof A, coin: Address, quote: Address, side: "buy" | "sell", amount: bigint, poolId: Hex) {
    const events = parseEventLogs({ abi: memeFunHookAbi, eventName: "Trade", logs: receipt.logs });
    const event = events.find(e => same(e.args.id, poolId) && same(e.args.coin, coin) && same(e.args.trader, account.address) && e.args.isBuy === (side === "buy"));
    check(event, "Trade event missing or wrong market");
    checkpoint(`trade:${coin}:${quote}:${side}`, { status: "confirmed", hash: receipt.transactionHash, blockNumber: receipt.blockNumber, account: account.address, coin, quote, side, amount, coinAmount: event.args.coinAmount, quoteAmount: event.args.quoteAmount, fee: event.args.fee, poolId });
    const beforeCoin = await tokenBalance(coin, account.address, receipt.blockNumber - 1n);
    const afterCoin = await tokenBalance(coin, account.address, receipt.blockNumber);
    check(side === "buy" ? afterCoin - beforeCoin === event.args.coinAmount : beforeCoin - afterCoin === amount && event.args.coinAmount === amount, "Trade token delta mismatch");
    const gasPaid = quote === zeroAddress ? feeOf(receipt) : 0n;
    const beforeQuote = await assetBalance(account.address, quote, receipt.blockNumber - 1n);
    const afterQuote = await assetBalance(account.address, quote, receipt.blockNumber);
    check(side === "buy" ? beforeQuote - afterQuote === amount + gasPaid : afterQuote + gasPaid - beforeQuote === event.args.quoteAmount - event.args.fee, "Trade quote delta mismatch");
    check(event.args.fee === (event.args.quoteAmount * event.args.feeBps + 9_999n) / 10_000n, "Trade fee mismatch");
    record("trade-receipt-balances", { hash: receipt.transactionHash, coin, quote, side, beforeQuote, afterQuote, beforeCoin, afterCoin, gasPaid });
    return event.args.coinAmount;
  }
  async function creatorClaims(account: typeof A, coin: Address) {
    for (const quote of [zeroAddress, d.usdc]) {
      const pending = await read<bigint>(d.feeVault, feeVaultAbi, "creatorPendingFor", [coin, quote]);
      if (pending === 0n) { record("creator-claim-empty", { coin, quote }); continue; }
      const receipt = await send("claim-creator", account, { address: d.feeVault, abi: feeVaultAbi, functionName: "claimCreatorFor", args: [coin, quote, A.address] });
      check(await read<bigint>(d.feeVault, feeVaultAbi, "creatorPendingFor", [coin, quote]) === 0n, "Creator pending did not clear");
      const claims = parseEventLogs({ abi: feeVaultAbi, eventName: "CreatorClaimed", logs: receipt.logs });
      const claim = claims.find(e => same(e.address, d.feeVault) && same(e.args.coin, coin) && same(e.args.currency, quote) && same(e.args.to, A.address) && same(e.args.creator, account.address));
      check(claim && claim.args.amount === pending, "Creator payout event mismatch");
      await verifyPayout(receipt, account, quote, claim.args.amount, "creator");
    }
  }
  async function verifyPayout(receipt: TransactionReceipt, payer: typeof A, quote: Address, amount: bigint, kind: string) {
    const before = await assetBalance(A.address, quote, receipt.blockNumber - 1n);
    const after = await assetBalance(A.address, quote, receipt.blockNumber);
    const gas = quote === zeroAddress && same(payer.address, A.address) ? feeOf(receipt) : 0n;
    check(after + gas - before === amount, `${kind} payout balance mismatch`);
    record(`${kind}-payout-receipt-balances`, { hash: receipt.transactionHash, quote, amount, before, after, gas });
  }
  async function drainB() {
    if (!bFunded || uncertain) return;
    const balance = await client.getBalance({ address: B.address });
    const fees = await client.estimateFeesPerGas();
    const gas = (await client.estimateGas({ account: B, to: A.address, data: DATA_SUFFIX, value: 0n, blockNumber: lastConfirmedReadBlock })) * 125n / 100n + 5_000n;
    const l1 = await estimateL1Fee(client, { account: B, to: A.address, data: DATA_SUFFIX, value: 0n });
    const reserve = gas * fees.maxFeePerGas + l1 * 2n + L1_BUFFER * 2n;
    if (balance <= bStart + reserve) { record("secondary-return-dust", { balance, baseline: bStart }); return; }
    await sendRaw("secondary-return", B, A.address, balance - bStart - reserve, "0x", true);
    record("secondary-remaining", { balance: await client.getBalance({ address: B.address }) });
  }

  save();
  console.log(`Public journal: ${journalPath}`);
  record("preflight", { eth: aStart, usdc: usdcStart, creationFee: terms.creationFee, protectionDurationSec: terms.protectionDurationSec });
  if (!broadcast) { journal.plan = { modes: ["creator", "burn", "holders", "floor"], pairs: [zeroAddress, d.usdc], nativeFirstBuysWei: [parseEther("0.00002"), parseEther("0.00002"), parseEther("0.0002"), parseEther("0.00002")], feeBps: 500, communityCreatorKeepBps: 2500, manual: ["Actual X OAuth and author claims", "Real keeper epoch at next UTC 00/12 boundary, then 12-hour veto"] }; save(); console.log("Read-only plan complete. --broadcast is required for uploads, SIWE and transactions."); return; }
  try {
    journal.status = "running"; save();
    const nonce = await post<{ nonce: string; chainId: number }>("/v1/auth/nonce", {});
    check(nonce.chainId === 8453, "API SIWE chain mismatch");
    const message = createSiweMessage({ address: A.address, chainId: 8453, domain: new URL(ORIGIN).host, nonce: nonce.nonce, uri: ORIGIN, version: "1" });
    const session = await post<{ token: string; address: Address }>("/v1/auth/verify", { address: A.address, message, signature: await A.signMessage({ message }) });
    check(same(session.address, A.address) && Boolean(session.token), "SIWE session mismatch");
    record("siwe-sign-in");
    const logo = readFileSync(resolve(ROOT, "../memefun/public/memefun-logo.png"));
    const image = await api<{ uri: string }>("/v1/media/image", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(logo) }, session.token);
    if (resume) record("allowance-baseline", { owner: A.address, token: d.usdc, spender: d.factory, amount: resume.originalFactoryAllowance, inherited: true });
    await ensureAllowance(A, d.usdc, d.factory, resume ? 15_000n : 20_000n);
    const fdv = await read<bigint>(d.config, memeFunConfigAbi, "openingFdvUsdE8");
    for (const [mode, modeName] of ["Creator", "Burn", "Holders", "Floor"].entries()) {
      let coin: Address;
      let markets: MarketEvent[];
      if (mode === 0 && resume) {
        coin = resume.creator.coin;
        markets = resume.creator.markets;
        await verifyCoin(coin, mode, markets, markets.reduce((sum, market) => sum + market.record.firstBuyCoins, 0n) + resume.ethBuyOutput);
        await verifyTrade(resume.ethBuyReceipt, A, coin, zeroAddress, "buy", parseEther("0.000001"), markets.find(market => market.quote === zeroAddress)!.poolId);
        record("resume-reused-Creator", { coin, priorBuyHash: resume.ethBuyReceipt.transactionHash, bought: resume.ethBuyOutput });
      } else {
      const name = `QA TEST ${modeName} ${runId.slice(-6)}`;
      const symbol = `QA${["C", "B", "H", "F"][mode]}${runId.slice(-4).toUpperCase()}`;
      const metadata = await post<{ contractURI: string }>("/v1/media/metadata", { name, symbol, image: image.uri, description: `MAINNET QA TEST ONLY. Created to verify MemeFun functionality. No investment purpose. Run ${runId}.` }, session.token);
      const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
      coin = await read<Address>(d.factory, memeFunFactoryAbi, "predictCoin", [A.address, salt]);
      const pairs = await Promise.all([zeroAddress, d.usdc].map(async (quote, i) => {
        const firstBuyAmount = i === 1 ? FIRST_USDC : parseEther(mode === 2 ? "0.0002" : "0.00002");
        const decimals = i === 1 ? 6 : 18;
        const coinIsCurrency0 = BigInt(coin) < BigInt(quote);
        const price = await read<bigint>(d.config, memeFunConfigAbi, "quotePriceUsdE8", [quote]);
        const expectedStartTick = startTickExact({ coinIsCurrency0, quoteDecimals: decimals, quoteUsdE8: price, openingFdvUsdE8: fdv });
        const quoted = quoteBuy(launchPoolAt(expectedStartTick, coinIsCurrency0, decimals, { supply: COIN_SUPPLY / 2n }), firstBuyAmount, 500);
        check(!quoted.partial && quoted.amountOut > 0n, "First buy quote invalid");
        return { quote, firstBuyAmount, firstBuyMinCoins: minOut(quoted.amountOut, 500), expectedStartTick, maxTickDrift: 400 };
      }));
      const baseParams = { name, symbol, contractURI: metadata.contractURI, ...pairs[0]!, mode, feeBps: 500, creatorKeepBps: mode === 0 ? 0 : 2500, salt, deadline: (await client.getBlock()).timestamp + 300n };
      const receipt = await send(`launch-${modeName}`, A, { address: d.factory, abi: memeFunFactoryAbi, functionName: "launchMulti", args: [baseParams, pairs], value: terms.creationFee + pairs[0]!.firstBuyAmount });
      markets = parseEventLogs({ abi: memeFunFactoryAbi, eventName: "MarketLaunched", logs: receipt.logs }).map(e => e.args as unknown as MarketEvent);
      check(markets.length === 2 && markets.every(m => same(m.coin, coin) && m.record.feeBps === 500n && m.allocation === COIN_SUPPLY / 2n), "Launch event mismatch");
      journal.coins.push({ mode: modeName.toLowerCase(), coin, markets }); save();
      await verifyCoin(coin, mode, markets);
      }
      checkpoint(`mode:${modeName}:launch`, { status: "confirmed", coin, markets });
      const config = await read<PoolConfig>(d.hook, memeFunHookAbi, "configOf", [coin]);
      while ((await client.getBlock()).timestamp < BigInt(config.launchedAt) + BigInt(config.protectionDurationSec)) await new Promise(r => setTimeout(r, 2_000));
      await freshnessBarrier((await client.getBlockNumber({ cacheTime: 0 })) + 2n);
      for (const quote of [zeroAddress, d.usdc]) {
        const bought = mode === 0 && resume && quote === zeroAddress ? resume.ethBuyOutput : await trade(A, coin, quote, "buy", quote === zeroAddress ? parseEther("0.000001") : 1_000n);
        await trade(A, coin, quote, "sell", bought / 2n);
      }
      await creatorClaims(A, coin);
      if (mode === 1 || mode === 3) for (const quote of [zeroAddress, d.usdc]) {
        const burn = mode === 1;
        const address = burn ? d.buybackBurnVault : d.floorVault;
        const abi: Abi = burn ? buybackBurnVaultAbi : floorVaultAbi;
        const metric = burn ? "totalBurnedFor" : "totalFlooredFor";
        const before = await read<bigint>(address, abi, metric, [coin, quote]);
        const deadBefore = burn ? await read<bigint>(coin, erc20Abi, "balanceOf", [DEAD_ADDRESS]) : 0n;
        const call: Call = { address, abi, functionName: burn ? "executeBuybackFor" : "addFloorFor", args: [coin, quote] };
        const receipt = await send(burn ? "execute-burn" : "add-floor", A, call);
        check(await read<bigint>(address, abi, metric, [coin, quote]) > before, "Module totals did not increase");
        if (burn) check(await read<bigint>(coin, erc20Abi, "balanceOf", [DEAD_ADDRESS]) > deadBefore, "Dead balance did not increase");
        else check(await read<boolean>(address, abi, "hasFloorFor", [coin, quote]), "Floor state missing");
        const eventName = burn ? "MarketBuyback" : "MarketFloorAdded";
        check(parseEventLogs({ abi, eventName, logs: receipt.logs }).length > 0, "Module event missing");
        await reject("module-cooldown", A, call, "CoolingDown");
      }
      if (mode === 2) {
        const pending = await read<bigint>(d.feeVault, feeVaultAbi, "destinationPendingFor", [coin, zeroAddress]);
        check(pending > 0n, "Holder fee reserve missing");
        record("holder-reserve-timegate", { coin, pendingEth: pending, nextUtcWindowEnd: ((await client.getBlock()).timestamp / 43_200n + 1n) * 43_200n, vetoSecondsAfterRealPublication: 43_200, note: "No ad-hoc root published. Backend keeper/proof/claim test remains." });
      }
      checkpoint(`mode:${modeName}:immediate-tests`, { status: "verified", coin });
    }
    const creator = journal.coins.find(c => c.mode === "creator")!.coin;
    await send("creator-lower-fee", A, { address: d.hook, abi: memeFunHookAbi, functionName: "lowerFee", args: [creator, 100n] });
    for (const quote of [zeroAddress, d.usdc]) check(Number((await read<PoolConfig>(d.hook, memeFunHookAbi, "configFor", [creator, quote])).feeBps) === 100, "Fee reduction missing from market");
    await reject("creator-cannot-increase", A, { address: d.hook, abi: memeFunHookAbi, functionName: "lowerFee", args: [creator, 500n] }, "FeeNotLower");
    await sendRaw("fund-secondary", A, B.address, B_FUND, "0x");
    bFunded = true;
    await trade(A, creator, zeroAddress, "buy", parseEther("0.000001"), B.address);
    const referral = await read<bigint>(d.feeVault, feeVaultAbi, "referralPending", [B.address, zeroAddress]);
    check(referral > 0n, "Referral earnings missing");
    const referralReceipt = await send("claim-referral", B, { address: d.feeVault, abi: feeVaultAbi, functionName: "claimReferral", args: [zeroAddress, A.address] });
    check(await read<bigint>(d.feeVault, feeVaultAbi, "referralPending", [B.address, zeroAddress]) === 0n, "Referral pending did not clear");
    check(parseEventLogs({ abi: feeVaultAbi, eventName: "ReferralClaimed", logs: referralReceipt.logs }).some(event => same(event.address, d.feeVault) && same(event.args.referrer, B.address) && same(event.args.to, A.address) && event.args.amount === referral), "Referral payout event mismatch");
    await verifyPayout(referralReceipt, B, zeroAddress, referral, "referral");
    await send("creator-propose-B", A, { address: d.hook, abi: memeFunHookAbi, functionName: "proposeCreator", args: [creator, B.address] });
    await send("creator-accept-B", B, { address: d.hook, abi: memeFunHookAbi, functionName: "acceptCreator", args: [creator] });
    check(same(await read<Address>(d.hook, memeFunHookAbi, "creatorOf", [creator]), B.address), "Creator transfer missing");
    await reject("old-creator-authority", A, { address: d.hook, abi: memeFunHookAbi, functionName: "lowerFee", args: [creator, 50n] }, "NotCreator");
    await creatorClaims(B, creator);
    await send("creator-propose-A", B, { address: d.hook, abi: memeFunHookAbi, functionName: "proposeCreator", args: [creator, A.address] });
    await send("creator-accept-A", A, { address: d.hook, abi: memeFunHookAbi, functionName: "acceptCreator", args: [creator] });
    check(same(await read<Address>(d.hook, memeFunHookAbi, "creatorOf", [creator]), A.address), "Creator restoration missing");
    for (const quote of [zeroAddress, d.usdc]) {
      check(same(await read<Address>(d.config, memeFunConfigAbi, "treasury"), A.address), "Platform treasury changed");
      const pending = await read<bigint>(d.feeVault, feeVaultAbi, "platformPending", [quote]);
      if (pending > 0n) {
        const receipt = await send("platform-claim-fixed-treasury", A, { address: d.feeVault, abi: feeVaultAbi, functionName: "claimPlatform", args: [quote] });
        const payout = parseEventLogs({ abi: feeVaultAbi, eventName: "PlatformClaimed", logs: receipt.logs }).find(event => same(event.address, d.feeVault) && same(event.args.currency, quote) && same(event.args.treasury, A.address));
        check(payout && payout.args.amount === pending && await read<bigint>(d.feeVault, feeVaultAbi, "platformPending", [quote]) === 0n, "Platform ledger/event mismatch");
        await verifyPayout(receipt, A, quote, payout.args.amount, "platform");
      }
    }
    await restoreAllowances();
    await drainB();
    journal.status = "completed-immediate-tests";
    journal.remaining = ["Real keeper Holder publication after next UTC 00/12 boundary and claim after publication +12h", "Human X OAuth/post author verification and author fee claim", "Browser Privy/smart-wallet UX smoke"];
    journal.finalBalances = { ethA: await client.getBalance({ address: A.address }), ethB: await client.getBalance({ address: B.address }), usdcA: await read<bigint>(d.usdc, erc20Abi, "balanceOf", [A.address]) }; save();
    console.log(`Immediate tests complete. Spending ${journal.spentWei} wei; timed/manual checks recorded in public journal.`);
  } catch (error) {
    journal.status = uncertain ? "uncertain-stop-do-not-rerun" : "failed-stop-do-not-rerun";
    journal.error = safeError(error); save();
    // Cleanup never retries an uncertain transaction or changes creator authority automatically.
    if (!uncertain) {
      await restoreAllowances().catch(cleanupError => { journal.allowanceCleanupError = safeError(cleanupError); save(); });
      await drainB().catch(cleanupError => { journal.cleanupError = safeError(cleanupError); save(); });
    }
    throw new Error(`${safeError(error)}. Inspect public journal before proceeding.`);
  }
}

main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
