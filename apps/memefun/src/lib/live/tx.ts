import {
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  domainSeparator,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseEventLogs,
  parseSignature,
  size,
  toHex,
  verifyTypedData,
  zeroAddress,
} from "viem";
import { launchPoolAt, minOut, quoteBuy, startTickExact } from "@/core/pool";
import { equalAllocations } from "@/lib/market/markets";
import type { FeeMode } from "@/core/types";
import { AUTHOR_VERIFICATION_TYPES, TWEET_LAUNCH_TYPES, validateAuthorShareBps, validXId, type AuthorVerification, type TweetLaunchAttestation } from "@/core/tweet";
import type { OwnerCall } from "@/lib/admin/ownerCalls";
import { feeVaultAbi, holderRewardDistributorAbi, memeFunConfigAbi, memeFunFactoryAbi, memeFunHookAbi, memeFunRouterAbi } from "@/lib/contracts/abis";
import type { MemefunDeployment } from "@/lib/contracts/deployments";
import { TxError, type TxStage } from "@/lib/market/Market";
import { isUserRejectedRequest } from "@/lib/wallet/paymaster";
import { DATA_SUFFIX } from "@/lib/wallet/builderCode";
import { revertName, toTxError } from "./txErrors";

/**
 * Every memefun transaction, written against plain viem clients so it runs the same in the
 * browser (a wagmi connector's wallet client) and in tests (a local account on anvil).
 *
 * Each call is simulated first, so a doomed transaction never reaches the wallet and its revert
 * comes back as a plain message; then sent with the builder-code suffix; then awaited, and a
 * reverted receipt is an error too. Token approvals cover exactly the amount, never unlimited.
 */
export type TxWallet = WalletClient<Transport, Chain, Account>;

export type { TxStage } from "@/lib/market/Market";

export interface TxContext {
  wallet: TxWallet;
  client: PublicClient;
  deployment: MemefunDeployment;
  /** Optional assertion for adapters/tests; another suffix is rejected before submission. */
  dataSuffix?: Hex;
  /** What the person is being asked to do right now, for button labels. */
  onStage?: (stage: TxStage) => void;
}

/** The start tick may move this far (2 spacings, about 4%) between the quote and the launch. */
export const MAX_TICK_DRIFT = 400;
const RECEIPT_TIMEOUT_MS = 180_000;

type Request = Parameters<TxWallet["writeContract"]>[0];

const faucetAbi = parseAbi(["function drip()", "function nextDripAt(address account) view returns (uint256)"]);
const permitAbi = parseAbi([
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);
const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const MODE_INDEX: Record<FeeMode, number> = { creator: 0, burn: 1, holders: 2, floor: 3 };

function account(ctx: TxContext): Address {
  return ctx.wallet.account.address;
}

/**
 * A contract/delegated wallet needs attribution on its outer transaction/user operation.
 * A verified EOA can append directly. Capability errors never authorize a contract wallet
 * to fall back to a nested suffix that Base may not index.
 */
async function usesAttributedCalls(ctx: TxContext): Promise<boolean> {
  // Locally signing accounts send the actual transaction calldata.
  if (ctx.wallet.account.type === "local") return false;
  let capabilities: Awaited<ReturnType<TxWallet["getCapabilities"]>> | undefined;
  try {
    if (typeof ctx.wallet.getCapabilities === "function") {
      capabilities = await ctx.wallet.getCapabilities({ account: ctx.wallet.account, chainId: ctx.wallet.chain.id });
    }
  } catch (error) {
    if (isUserRejectedRequest(error)) throw new TxError("You rejected the request in your wallet.", "rejected");
    // A legacy EOA provider may not implement EIP-5792. Verify its chain code below.
  }
  const chainCapabilities = capabilities as { dataSuffix?: { supported?: boolean }; atomic?: { status?: string; supported?: boolean } } | undefined;
  if (chainCapabilities?.dataSuffix?.supported === true) return true;
  const atomic = chainCapabilities?.atomic;
  if (atomic?.supported === true || atomic?.status === "supported" || atomic?.status === "ready") {
    throw new TxError("This wallet cannot provide the required transaction attribution. Connect an EOA wallet or a wallet that supports Base builder codes.", "reverted");
  }
  let code: Hex | undefined;
  try { code = await ctx.client.getCode({ address: account(ctx) }); }
  catch { throw new TxError("The wallet's transaction support could not be checked. Try again before submitting.", "reverted"); }
  if (code && code !== "0x") {
    throw new TxError("This smart wallet cannot provide the required transaction attribution. Connect an EOA wallet or a wallet that supports Base builder codes.", "reverted");
  }
  return false;
}

const UNCERTAIN_CALLS = "The wallet request may have been sent but its confirmation could not be read. Check your wallet's activity before trying again.";

async function sendAttributedCall(ctx: TxContext, request: Request, fallback: string): Promise<Hash> {
  let id: string;
  try {
    const result = await ctx.wallet.sendCalls({
      account: ctx.wallet.account,
      chain: ctx.wallet.chain,
      calls: [{ to: request.address, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }), value: request.value }],
      capabilities: { dataSuffix: { value: DATA_SUFFIX } },
      forceAtomic: true,
      experimental_fallback: false,
    });
    ctx.onStage?.("pending");
    if (!result.id || typeof result.id !== "string") throw new TxError(UNCERTAIN_CALLS, "reverted");
    id = result.id;
  } catch (error) {
    // Never retry through eth_sendTransaction: a wallet may have accepted an ambiguous call.
    throw toTxError(error, UNCERTAIN_CALLS);
  }
  let status: Awaited<ReturnType<TxWallet["waitForCallsStatus"]>>;
  try {
    status = await ctx.wallet.waitForCallsStatus({ id, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: 1_000, retryCount: 0 });
  } catch { throw new TxError(UNCERTAIN_CALLS, "reverted"); }
  const receipt = status.receipts?.length === 1 ? status.receipts[0] : undefined;
  const hash = receipt?.transactionHash;
  if (status.status === "failure" || receipt?.status === "reverted") throw new TxError(fallback, "reverted", hash);
  if (status.status !== "success" || receipt?.status !== "success" || !hash || !/^0x[\da-f]{64}$/i.test(hash)
    || (status.chainId !== undefined && status.chainId !== ctx.wallet.chain.id)) {
    throw new TxError(UNCERTAIN_CALLS, "reverted", hash);
  }
  return hash;
}

/** Sends a simulated request and waits for it; any failure becomes a TxError. */
async function submit(ctx: TxContext, request: Request, fallback: string): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  if (ctx.dataSuffix !== undefined && ctx.dataSuffix.toLowerCase() !== DATA_SUFFIX.toLowerCase()) {
    throw new TxError("The transaction builder code does not match DustSwap. Refresh before trying again.", "reverted");
  }
  const useCalls = await usesAttributedCalls(ctx);
  ctx.onStage?.("confirm");
  let hash: Hash;
  try {
    // Always attach the registered code, including approvals and callers with no context suffix.
    // The explicit value takes precedence over the client default, so it is appended once.
    hash = useCalls ? await sendAttributedCall(ctx, request, fallback)
      : await ctx.wallet.writeContract({ ...request, dataSuffix: DATA_SUFFIX } as Request);
  } catch (error) {
    throw toTxError(error, fallback);
  }
  ctx.onStage?.("pending");
  let receipt: TransactionReceipt;
  try {
    receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  } catch {
    throw new TxError("The transaction was sent but has not confirmed yet. Check your wallet's activity before trying again.", "reverted", hash);
  }
  if (receipt.status !== "success") throw new TxError(fallback, "reverted", hash);
  return { hash, receipt };
}

/** Approves exactly `amount` and waits for it. */
async function approve(ctx: TxContext, token: Address, spender: Address, amount: bigint) {
  ctx.onStage?.("approve");
  let request: Request;
  try {
    ({ request } = await ctx.client.simulateContract({ account: ctx.wallet.account, address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }));
  } catch (error) {
    throw toTxError(error, "The approval did not go through.");
  }
  await submit(ctx, request, "The approval did not go through.");
}

async function allowance(ctx: TxContext, token: Address, spender: Address): Promise<bigint> {
  return ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account(ctx), spender] });
}

interface PermitSignature {
  value: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * An ERC-2612 permit for `spender`, or null when the token or the wallet cannot do one (then the
 * caller approves instead). A rejection in the wallet is final, not a fallback.
 */
export async function signPermit(ctx: TxContext, token: Address, spender: Address, value: bigint, deadline: bigint): Promise<PermitSignature | null> {
  const owner = account(ctx);
  let domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  let nonce: bigint;
  try {
    nonce = await ctx.client.readContract({ address: token, abi: permitAbi, functionName: "nonces", args: [owner] });
    domain = await permitDomain(ctx, token);
  } catch {
    return null;
  }
  ctx.onStage?.("sign");
  let signature: Hex;
  try {
    signature = await ctx.wallet.signTypedData({
      account: ctx.wallet.account,
      domain,
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: { owner, spender, value, nonce, deadline },
    });
  } catch (error) {
    if (isUserRejectedRequest(error)) throw new TxError("You rejected the request in your wallet.", "rejected");
    return null;
  }
  // Smart wallets sign with ERC-1271 or 6492, which a token's permit cannot check.
  if (size(signature) !== 65) return null;
  const { r, s, v, yParity } = parseSignature(signature);
  return { value, deadline, v: v !== undefined ? Number(v) : yParity + 27, r, s };
}

/** The token's EIP-712 domain, from EIP-5267 when it has it, checked against DOMAIN_SEPARATOR. */
async function permitDomain(ctx: TxContext, token: Address) {
  const chainId = ctx.wallet.chain.id;
  let domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  try {
    const [, name, version, domainChainId, verifyingContract] = await ctx.client.readContract({ address: token, abi: permitAbi, functionName: "eip712Domain" });
    domain = { name, version, chainId: Number(domainChainId), verifyingContract };
  } catch {
    const name = await ctx.client.readContract({ address: token, abi: permitAbi, functionName: "name" });
    const version = await ctx.client.readContract({ address: token, abi: permitAbi, functionName: "version" }).catch(() => "1");
    domain = { name, version, chainId, verifyingContract: token };
  }
  const expected = await ctx.client.readContract({ address: token, abi: permitAbi, functionName: "DOMAIN_SEPARATOR" });
  if (domainSeparator({ domain }) !== expected) throw new Error("unknown permit domain");
  return domain;
}

/* ---------------------------------------------------------------- trade */

export interface TradeRequest {
  explicitPool?: boolean;
  side: "buy" | "sell";
  coin: Address;
  /** The coin's pair asset; the zero address is ETH. */
  quote: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  referrer?: Address | null;
  deadline: bigint;
}

export interface TradeFill {
  hash: Hash;
  isBuy: boolean;
  /** What the trader paid (buy) or received (sell) in the pair asset, fee included in a buy. */
  quoteAmount: bigint;
  coinAmount: bigint;
  fee: bigint;
  feeBps: number;
  sqrtPriceX96: bigint;
  tick: number;
  blockNumber: bigint;
}

const TRADE_FALLBACK = "The trade did not go through. Nothing was spent except the network fee.";

/** True when a simulation failed only because the router may not pull the tokens yet. */
function isAllowanceFailure(error: unknown): boolean {
  const name = revertName(error);
  return name !== null && /allowance|SafeERC20FailedOperation|transfer amount exceeds/i.test(name);
}

export async function sendTrade(ctx: TxContext, t: TradeRequest): Promise<TradeFill> {
  const router = ctx.deployment.router;
  const params = {
    coin: t.coin,
    amountIn: t.amountIn,
    minAmountOut: t.minAmountOut,
    recipient: zeroAddress,
    referrer: t.referrer ?? zeroAddress,
    deadline: t.deadline,
  } as const;
  const simulate = async (withPermit: PermitSignature | null): Promise<Request> => {
    const base = { account: ctx.wallet.account, address: router, abi: memeFunRouterAbi } as const;
    if (t.explicitPool) {
      if (withPermit) return t.side === "buy"
        ? (await ctx.client.simulateContract({ ...base, functionName: "buyForWithPermit", args: [params, t.quote, withPermit] })).request as Request
        : (await ctx.client.simulateContract({ ...base, functionName: "sellForWithPermit", args: [params, t.quote, withPermit] })).request as Request;
      return t.side === "buy"
        ? (await ctx.client.simulateContract({ ...base, functionName: "buyFor", args: [params, t.quote], value: t.quote === zeroAddress ? t.amountIn : 0n })).request as Request
        : (await ctx.client.simulateContract({ ...base, functionName: "sellFor", args: [params, t.quote] })).request as Request;
    }
    if (t.side === "buy" && t.quote === zeroAddress) {
      return (await ctx.client.simulateContract({ ...base, functionName: "buy", args: [params], value: t.amountIn })).request as Request;
    }
    if (withPermit) {
      return t.side === "buy"
        ? ((await ctx.client.simulateContract({ ...base, functionName: "buyWithPermit", args: [params, withPermit] })).request as Request)
        : ((await ctx.client.simulateContract({ ...base, functionName: "sellWithPermit", args: [params, withPermit] })).request as Request);
    }
    return t.side === "buy"
      ? ((await ctx.client.simulateContract({ ...base, functionName: "buy", args: [params] })).request as Request)
      : ((await ctx.client.simulateContract({ ...base, functionName: "sell", args: [params] })).request as Request);
  };

  let request: Request | null = null;
  try {
    const token = t.side === "buy" ? t.quote : t.coin;
    if (token === zeroAddress || (await allowance(ctx, token, router)) >= t.amountIn) {
      request = await simulate(null);
    } else {
      // One signature and one transaction where the token and wallet allow it.
      const permit = await signPermit(ctx, token, router, t.amountIn, t.deadline);
      if (permit) {
        try {
          request = await simulate(permit);
        } catch (error) {
          if (!isAllowanceFailure(error)) throw error;
        }
      }
      if (!request) {
        await approve(ctx, token, router, t.amountIn);
        request = await simulate(null);
      }
    }
  } catch (error) {
    throw toTxError(error, TRADE_FALLBACK);
  }

  const { hash, receipt } = await submit(ctx, request, TRADE_FALLBACK);
  const trader = account(ctx).toLowerCase();
  const log = parseEventLogs({ abi: memeFunHookAbi, eventName: "Trade", logs: receipt.logs }).find(
    (entry) => entry.args.coin.toLowerCase() === t.coin.toLowerCase() && entry.args.trader.toLowerCase() === trader,
  );
  if (!log) throw new TxError("The trade confirmed but its result could not be read. Refresh to see your balance.", "reverted", hash);
  return {
    hash,
    isBuy: log.args.isBuy,
    quoteAmount: log.args.quoteAmount,
    coinAmount: log.args.coinAmount,
    fee: log.args.fee,
    feeBps: Number(log.args.feeBps),
    sqrtPriceX96: log.args.sqrtPriceX96,
    tick: log.args.tick,
    blockNumber: receipt.blockNumber,
  };
}

/* --------------------------------------------------------------- launch */

export interface LaunchRequest {
  tweet?: TweetLaunchAttestation;
  pairs?: Array<{ quote: Address; quoteDecimals: number; firstBuy: bigint }>;
  name: string;
  symbol: string;
  contractURI: string;
  quote: Address;
  quoteDecimals: number;
  mode: FeeMode;
  feeBps: number;
  creatorKeepBps: number;
  firstBuy: bigint;
  slippageBps: number;
  deadline: bigint;
  /** Fixed in tests; random otherwise. */
  salt?: Hex;
}

export interface LaunchResult {
  markets?: Array<{ poolId: Hex; quote: Address; coinsBought: bigint }>;
  hash: Hash;
  coin: Address;
  coinsBought: bigint;
  quoteSpent: bigint;
  blockNumber: bigint;
}

const LAUNCH_FALLBACK = "The launch did not go through and nothing was created. Only the network fee was spent.";

/** The first buy's minimum coins, from the pool the factory will seed at `startTick`. */
export function firstBuyMinCoins(startTick: number, coinIsCurrency0: boolean, quoteDecimals: number, firstBuy: bigint, feeBps: number, slippageBps: number, allocationSupply?: bigint): bigint {
  if (firstBuy === 0n) return 0n;
  const quoted = quoteBuy(launchPoolAt(startTick, coinIsCurrency0, quoteDecimals, { supply: allocationSupply }), firstBuy, feeBps);
  if (quoted.partial) throw new TxError("The first buy is larger than the whole supply. Lower it.", "reverted");
  return minOut(quoted.amountOut, slippageBps);
}

async function trustedTweetSigner(ctx: TxContext): Promise<Address> {
  const signer = await ctx.client.readContract({ address: ctx.deployment.config, abi: memeFunConfigAbi, functionName: "tweetAttestor" });
  if (signer === zeroAddress) throw new TxError("Tweet launches and author verification are not enabled on this network yet.", "reverted");
  return signer;
}

async function validateTweetAttestation(ctx: TxContext, value: TweetLaunchAttestation, salt: Hex, mode: FeeMode): Promise<void> {
  if (mode !== "creator" || value.launcher.toLowerCase() !== account(ctx).toLowerCase() || value.factory.toLowerCase() !== ctx.deployment.factory.toLowerCase()
    || value.chainId !== ctx.deployment.chainId || value.salt.toLowerCase() !== salt.toLowerCase() || value.reserveDays !== 180
    || !validXId(value.tweet.postId) || !validXId(value.tweet.authorXUserId) || !validateAuthorShareBps(value.tweet.authorShareBps)
    || value.source.postId !== value.tweet.postId || value.source.author.id !== value.tweet.authorXUserId || !/^\d{1,20}$/.test(value.deadline)) {
    throw new TxError("The X launch authorization does not match this wallet, post or network. Import the post again.", "reverted");
  }
  const deadline = BigInt(value.deadline);
  const block = await ctx.client.getBlock();
  if (deadline < block.timestamp) throw new TxError("The X launch authorization expired. Try launching again.", "reverted");
  const valid = await verifyTypedData({ address: await trustedTweetSigner(ctx), domain: { name: "MemeFunFactory", version: "1", chainId: ctx.deployment.chainId, verifyingContract: ctx.deployment.factory },
    types: TWEET_LAUNCH_TYPES, primaryType: "TweetLaunch", message: { launcher: value.launcher, salt: value.salt, postId: BigInt(value.tweet.postId), authorXUserId: BigInt(value.tweet.authorXUserId), authorShareBps: value.tweet.authorShareBps, deadline }, signature: value.signature });
  if (!valid) throw new TxError("The X post authorization could not be verified. Import the post again.", "reverted");
}

/** Bind a wallet only using a fresh, chain-bound proof from the official X sign-in flow. */
export async function sendAuthorVerification(ctx: TxContext, value: AuthorVerification): Promise<Hash> {
  const fallback = "The author wallet verification did not go through.";
  try {
    if (value.wallet.toLowerCase() !== account(ctx).toLowerCase() || value.chainId !== ctx.deployment.chainId
      || value.feeVault.toLowerCase() !== ctx.deployment.feeVault.toLowerCase() || !validXId(value.authorXUserId) || !/^\d{1,20}$/.test(value.deadline)) {
      throw new TxError("This X verification belongs to a different wallet or network. Connect X again.", "reverted");
    }
    const deadline = BigInt(value.deadline);
    if (deadline < (await ctx.client.getBlock()).timestamp) throw new TxError("This X verification expired. Connect X again.", "reverted");
    const valid = await verifyTypedData({ address: await trustedTweetSigner(ctx), domain: { name: "MemeFunFeeVault", version: "1", chainId: ctx.deployment.chainId, verifyingContract: ctx.deployment.feeVault },
      types: AUTHOR_VERIFICATION_TYPES, primaryType: "AuthorVerification", message: { coin: value.coin, authorXUserId: BigInt(value.authorXUserId), wallet: value.wallet, deadline }, signature: value.signature });
    if (!valid) throw new TxError("The X verification signature could not be verified. Connect X again.", "reverted");
    const request = (await ctx.client.simulateContract({ account: ctx.wallet.account, address: ctx.deployment.feeVault, abi: feeVaultAbi, functionName: "verifyAuthor", args: [value.coin, value.wallet, deadline, value.signature] })).request as Request;
    return (await submit(ctx, request, fallback)).hash;
  } catch (error) { throw toTxError(error, fallback); }
}

/** Only the current configured treasury may withdraw; the vault fixes the payout wallet. */
export async function sendTreasuryAuthorWithdrawal(ctx: TxContext, coin: Address, currency: Address): Promise<Hash> {
  const fallback = "The treasury withdrawal did not go through. Refresh the balance before trying again.";
  try {
    const treasury = await ctx.client.readContract({ address: ctx.deployment.config, abi: memeFunConfigAbi, functionName: "treasury" });
    if (treasury.toLowerCase() !== account(ctx).toLowerCase()) throw new TxError("Connect the current DustSwap treasury wallet to withdraw these rewards.", "reverted");
    const request = (await ctx.client.simulateContract({ account: ctx.wallet.account, address: ctx.deployment.feeVault, abi: feeVaultAbi,
      functionName: "reclaimExpiredAuthorFor", args: [coin, currency] })).request as Request;
    return (await submit(ctx, request, fallback)).hash;
  } catch (error) { throw toTxError(error, fallback); }
}

export async function sendLaunch(ctx: TxContext, l: LaunchRequest): Promise<LaunchResult> {
  const { config, factory } = ctx.deployment;
  const creator = account(ctx);
  let request: Request;
  try {
    const [terms, quoteUsdE8, openingFdvUsdE8] = await Promise.all([
      ctx.client.readContract({ address: config, abi: memeFunConfigAbi, functionName: "launchTerms" }),
      ctx.client.readContract({ address: config, abi: memeFunConfigAbi, functionName: "quotePriceUsdE8", args: [l.quote] }),
      ctx.client.readContract({ address: config, abi: memeFunConfigAbi, functionName: "openingFdvUsdE8" }),
    ]);
    if (terms.launchesPaused) throw new TxError("New launches are paused right now. Existing coins trade as normal.", "reverted");

    const salt = l.salt ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
    const predicted = await ctx.client.readContract({ address: factory, abi: memeFunFactoryAbi, functionName: "predictCoin", args: [creator, salt] });
    if (l.tweet) await validateTweetAttestation(ctx, l.tweet, salt, l.mode);
    if (l.tweet || (l.pairs && l.pairs.length > 1)) {
      const launchPairs = l.pairs?.length ? l.pairs : [{ quote: l.quote, quoteDecimals: l.quoteDecimals, firstBuy: l.firstBuy }];
      const allocations = equalAllocations(launchPairs.length);
      if (new Set(launchPairs.map((pair) => pair.quote.toLowerCase())).size !== launchPairs.length) throw new TxError("Every pool needs a different pair asset.", "reverted");
      const pairs = await Promise.all(launchPairs.map(async (pair, i) => {
        const price = await ctx.client.readContract({ address: config, abi: memeFunConfigAbi, functionName: "quotePriceUsdE8", args: [pair.quote] });
        const order = BigInt(predicted) < BigInt(pair.quote);
        const expectedStartTick = startTickExact({ coinIsCurrency0: order, quoteDecimals: pair.quoteDecimals, quoteUsdE8: price, openingFdvUsdE8 });
        return { quote: pair.quote, firstBuyAmount: pair.firstBuy,
          firstBuyMinCoins: firstBuyMinCoins(expectedStartTick, order, pair.quoteDecimals, pair.firstBuy, l.feeBps, l.slippageBps, allocations[i]),
          expectedStartTick, maxTickDrift: MAX_TICK_DRIFT };
      }));
      for (const pair of pairs) if (pair.firstBuyAmount > 0n && pair.quote !== zeroAddress && await allowance(ctx, pair.quote, factory) < pair.firstBuyAmount) await approve(ctx, pair.quote, factory, pair.firstBuyAmount);
      const primary = pairs[0]!;
      const base = { name: l.name, symbol: l.symbol, contractURI: l.contractURI, ...primary,
        mode: MODE_INDEX[l.mode], feeBps: l.feeBps, creatorKeepBps: l.mode === "creator" ? 0 : l.creatorKeepBps, salt, deadline: l.deadline };
      const value = terms.creationFee + pairs.filter((pair) => pair.quote === zeroAddress).reduce((sum, pair) => sum + pair.firstBuyAmount, 0n);
      request = l.tweet ? (await ctx.client.simulateContract({ account: ctx.wallet.account, address: factory, abi: memeFunFactoryAbi,
        functionName: "launchTweetMulti", args: [base, pairs, { postId: BigInt(l.tweet.tweet.postId), authorXUserId: BigInt(l.tweet.tweet.authorXUserId), authorShareBps: l.tweet.tweet.authorShareBps }, BigInt(l.tweet.deadline), l.tweet.signature], value,
      })).request as Request : (await ctx.client.simulateContract({ account: ctx.wallet.account, address: factory, abi: memeFunFactoryAbi,
        functionName: "launchMulti", args: [base, pairs], value,
      })).request as Request;
    } else {
    const coinIsCurrency0 = BigInt(predicted) < BigInt(l.quote);
    const expectedStartTick = startTickExact({ coinIsCurrency0, quoteDecimals: l.quoteDecimals, quoteUsdE8, openingFdvUsdE8 });
    // The first buy pays the base fee; slippage only has to cover the start tick moving.
    const minCoins = firstBuyMinCoins(expectedStartTick, coinIsCurrency0, l.quoteDecimals, l.firstBuy, l.feeBps, l.slippageBps);

    if (l.firstBuy > 0n && l.quote !== zeroAddress && (await allowance(ctx, l.quote, factory)) < l.firstBuy) {
      await approve(ctx, l.quote, factory, l.firstBuy);
    }
    request = (
      await ctx.client.simulateContract({
      account: ctx.wallet.account,
      address: factory,
      abi: memeFunFactoryAbi,
      functionName: "launch",
      args: [
        {
          name: l.name,
          symbol: l.symbol,
          contractURI: l.contractURI,
          quote: l.quote,
          mode: MODE_INDEX[l.mode],
          feeBps: l.feeBps,
          creatorKeepBps: l.mode === "creator" ? 0 : l.creatorKeepBps,
          salt,
          firstBuyAmount: l.firstBuy,
          firstBuyMinCoins: minCoins,
          expectedStartTick,
          maxTickDrift: MAX_TICK_DRIFT,
          deadline: l.deadline,
        },
      ],
      value: terms.creationFee + (l.quote === zeroAddress ? l.firstBuy : 0n),
    })
    ).request as Request;
    }
  } catch (error) {
    throw toTxError(error, LAUNCH_FALLBACK);
  }

  const { hash, receipt } = await submit(ctx, request, LAUNCH_FALLBACK);
  const launched = parseEventLogs({ abi: memeFunFactoryAbi, eventName: "Launched", logs: receipt.logs })[0];
  if (!launched) throw new TxError("The launch confirmed but the new coin could not be read. Check your profile in a moment.", "reverted", hash);
  return {
    markets: parseEventLogs({ abi: memeFunFactoryAbi, eventName: "MarketLaunched", logs: receipt.logs }).filter((log) => log.args.coin.toLowerCase() === launched.args.coin.toLowerCase()).map((log) => ({ poolId: log.args.poolId, quote: log.args.quote, coinsBought: log.args.record.firstBuyCoins })),
    hash,
    coin: launched.args.coin,
    coinsBought: launched.args.record.firstBuyCoins,
    quoteSpent: launched.args.record.firstBuyQuote,
    blockNumber: receipt.blockNumber,
  };
}

/* --------------------------------------------------------------- claims */

export interface ClaimRequest {
  poolId?: Hex;
  kind: "creator" | "holders" | "referral" | "author";
  coin: Address;
  /** The asset paid out. */
  currency: Address;
  amount: bigint;
  /** Holder rewards: the published leaf. */
  epoch?: number;
  index?: bigint;
  proof?: Hex[];
}

export async function sendCreatorAction(ctx: TxContext, coin: Address, action: "lowerFee" | "proposeCreator" | "acceptCreator", value?: Address | number): Promise<Hash> {
  const base = { account: ctx.wallet.account, address: ctx.deployment.hook, abi: memeFunHookAbi } as const;
  const fallback = "The creator change did not go through.";
  try {
    let request: Request;
    if (action === "lowerFee") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TxError("Enter a valid fee.", "reverted");
      request = (await ctx.client.simulateContract({ ...base, functionName: "lowerFee", args: [coin, BigInt(value)] })).request as Request;
    } else if (action === "proposeCreator") {
      if (typeof value !== "string") throw new TxError("Enter a wallet address.", "reverted");
      request = (await ctx.client.simulateContract({ ...base, functionName: "proposeCreator", args: [coin, value] })).request as Request;
    } else request = (await ctx.client.simulateContract({ ...base, functionName: "acceptCreator", args: [coin] })).request as Request;
    return (await submit(ctx, request, fallback)).hash;
  } catch (error) { throw toTxError(error, fallback); }
}

const CLAIM_FALLBACK = "A claim did not go through. Earlier confirmed claims may already have paid out; refresh rewards before retrying.";

/**
 * Claims everything given, in as few transactions as the contracts allow: one for all creator
 * earnings, one per referral asset, one for all holder rewards. Returns the last hash.
 */
export async function sendClaims(ctx: TxContext, items: ClaimRequest[], payoutTo?: Address): Promise<Hash> {
  const to = payoutTo ?? account(ctx);
  if (to === zeroAddress) throw new TxError("Choose a nonzero payout wallet.", "reverted");
  const { feeVault, holderRewardDistributor } = ctx.deployment;
  const requests: Array<() => Promise<Request>> = [];

  const creatorCoins = [...new Set(items.filter((i) => i.kind === "creator" && !i.poolId).map((i) => i.coin))];
  if (creatorCoins.length > 0) {
    requests.push(async () =>
      (await ctx.client.simulateContract({ account: ctx.wallet.account, address: feeVault, abi: feeVaultAbi, functionName: "claimCreatorMany", args: [creatorCoins, to] }))
        .request as Request,
    );
  }
  const creatorPools = new Map(items.filter((i) => i.kind === "creator" && i.poolId).map((i) => [`${i.coin}:${i.currency}`, i]));
  for (const item of creatorPools.values()) requests.push(async () =>
    (await ctx.client.simulateContract({ account: ctx.wallet.account, address: feeVault, abi: feeVaultAbi, functionName: "claimCreatorFor", args: [item.coin, item.currency, to] })).request as Request);
  const authorPools = new Map(items.filter((i) => i.kind === "author").map((i) => [`${i.coin.toLowerCase()}:${i.currency.toLowerCase()}`, i]));
  for (const item of authorPools.values()) requests.push(async () =>
    (await ctx.client.simulateContract({ account: ctx.wallet.account, address: feeVault, abi: feeVaultAbi, functionName: "claimAuthorFor", args: [item.coin, item.currency, account(ctx)] })).request as Request);
  for (const currency of new Set(items.filter((i) => i.kind === "referral").map((i) => i.currency))) {
    requests.push(async () =>
      (await ctx.client.simulateContract({ account: ctx.wallet.account, address: feeVault, abi: feeVaultAbi, functionName: "claimReferral", args: [currency, to] }))
        .request as Request,
    );
  }
  const poolHolders = items.filter((i) => i.kind === "holders" && i.poolId);
  if (poolHolders.length) {
    const claims = poolHolders.map((item) => {
      if (item.epoch === undefined || item.index === undefined || !item.proof) throw new TxError("These rewards are missing their proof.", "reverted");
      return { epoch: BigInt(item.epoch), poolId: item.poolId!, index: item.index, account: account(ctx), amount: item.amount, proof: item.proof };
    });
    requests.push(async () => (await ctx.client.simulateContract({ account: ctx.wallet.account, address: holderRewardDistributor, abi: holderRewardDistributorAbi, functionName: "claimManyFor", args: [claims] })).request as Request);
  }
  const holders = items.filter((i) => i.kind === "holders" && !i.poolId);
  if (holders.length > 0) {
    const claims = holders.map((i) => {
      if (i.epoch === undefined || i.index === undefined || !i.proof) throw new TxError("These rewards are missing their proof. Refresh and try again.", "reverted");
      return { epoch: BigInt(i.epoch), coin: i.coin, index: i.index, account: account(ctx), amount: i.amount, proof: i.proof };
    });
    requests.push(async () =>
      (
        await ctx.client.simulateContract({
          account: ctx.wallet.account,
          address: holderRewardDistributor,
          abi: holderRewardDistributorAbi,
          functionName: "claimMany",
          args: [claims],
        })
      ).request as Request,
    );
  }
  if (requests.length === 0) throw new TxError("There is nothing to claim.", "reverted");

  let last: Hash | null = null;
  for (const build of requests) {
    try {
      const request = await build();
      last = (await submit(ctx, request, CLAIM_FALLBACK)).hash;
    } catch (error) {
      const failed = toTxError(error, CLAIM_FALLBACK);
      if (last) throw new TxError(`${failed.message} Earlier claims confirmed; refresh rewards before retrying.`, failed.kind, failed.hash ?? last);
      throw failed;
    }
  }
  return last as Hash;
}

/* ----------------------------------------------------------- the faucet */

export async function sendDrip(ctx: TxContext): Promise<Hash> {
  const faucet = ctx.deployment.stockFaucet;
  if (!faucet) throw new TxError("This network has no test stock faucet.", "reverted");
  let request: Request;
  try {
    ({ request } = await ctx.client.simulateContract({ account: ctx.wallet.account, address: faucet, abi: faucetAbi, functionName: "drip" }));
  } catch (error) {
    throw toTxError(error, "The faucet did not send anything. Try again later.");
  }
  return (await submit(ctx, request, "The faucet did not send anything. Try again later.")).hash;
}

/* ------------------------------------------------------------- settings */

/** The owner's setters (admin/ownerCalls.ts), one transaction each, in order. */
export async function sendOwnerCalls(ctx: TxContext, calls: OwnerCall[]): Promise<Hash[]> {
  const owner = await ctx.client.readContract({ address: ctx.deployment.config, abi: memeFunConfigAbi, functionName: "owner" });
  if (owner.toLowerCase() !== account(ctx).toLowerCase()) {
    throw new TxError("Only the memefun owner wallet can change settings. Connect it and try again.", "reverted");
  }
  const hashes: Hash[] = [];
  for (const call of calls) {
    const args = call.args.map((arg) => (arg === "true" ? true : arg === "false" ? false : BigInt(arg)));
    let request: Request;
    try {
      request = (
        await ctx.client.simulateContract({
          account: ctx.wallet.account,
          address: ctx.deployment.config,
          abi: memeFunConfigAbi,
          functionName: call.fn as never,
          args: args as never,
        })
      ).request as Request;
    } catch (error) {
      throw toTxError(error, `"${call.summary}" did not go through.`);
    }
    hashes.push((await submit(ctx, request, `"${call.summary}" did not go through.`)).hash);
  }
  return hashes;
}
