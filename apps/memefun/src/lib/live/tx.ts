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
  erc20Abi,
  parseAbi,
  parseEventLogs,
  parseSignature,
  size,
  toHex,
  zeroAddress,
} from "viem";
import { launchPoolAt, minOut, quoteBuy, startTickExact } from "@/core/pool";
import type { FeeMode } from "@/core/types";
import type { OwnerCall } from "@/lib/admin/ownerCalls";
import { feeVaultAbi, holderRewardDistributorAbi, memeFunConfigAbi, memeFunFactoryAbi, memeFunHookAbi, memeFunRouterAbi } from "@/lib/contracts/abis";
import type { MemefunDeployment } from "@/lib/contracts/deployments";
import { TxError, type TxStage } from "@/lib/market/Market";
import { isUserRejectedRequest } from "@/lib/wallet/paymaster";
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
  /** ERC-8021 builder code, appended to every transaction's calldata. */
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

/** Sends a simulated request and waits for it; any failure becomes a TxError. */
async function submit(ctx: TxContext, request: Request, fallback: string): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  ctx.onStage?.("confirm");
  let hash: Hash;
  try {
    hash = await ctx.wallet.writeContract({ ...request, ...(ctx.dataSuffix ? { dataSuffix: ctx.dataSuffix } : {}) } as Request);
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
  hash: Hash;
  coin: Address;
  coinsBought: bigint;
  quoteSpent: bigint;
  blockNumber: bigint;
}

const LAUNCH_FALLBACK = "The launch did not go through and nothing was created. Only the network fee was spent.";

/** The first buy's minimum coins, from the pool the factory will seed at `startTick`. */
export function firstBuyMinCoins(startTick: number, coinIsCurrency0: boolean, quoteDecimals: number, firstBuy: bigint, feeBps: number, slippageBps: number): bigint {
  if (firstBuy === 0n) return 0n;
  const quoted = quoteBuy(launchPoolAt(startTick, coinIsCurrency0, quoteDecimals), firstBuy, feeBps);
  if (quoted.partial) throw new TxError("The first buy is larger than the whole supply. Lower it.", "reverted");
  return minOut(quoted.amountOut, slippageBps);
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
  } catch (error) {
    throw toTxError(error, LAUNCH_FALLBACK);
  }

  const { hash, receipt } = await submit(ctx, request, LAUNCH_FALLBACK);
  const launched = parseEventLogs({ abi: memeFunFactoryAbi, eventName: "Launched", logs: receipt.logs })[0];
  if (!launched) throw new TxError("The launch confirmed but the new coin could not be read. Check your profile in a moment.", "reverted", hash);
  return {
    hash,
    coin: launched.args.coin,
    coinsBought: launched.args.record.firstBuyCoins,
    quoteSpent: launched.args.record.firstBuyQuote,
    blockNumber: receipt.blockNumber,
  };
}

/* --------------------------------------------------------------- claims */

export interface ClaimRequest {
  kind: "creator" | "holders" | "referral";
  coin: Address;
  /** The asset paid out. */
  currency: Address;
  amount: bigint;
  /** Holder rewards: the published leaf. */
  epoch?: number;
  index?: bigint;
  proof?: Hex[];
}

const CLAIM_FALLBACK = "The claim did not go through. Nothing was paid out.";

/**
 * Claims everything given, in as few transactions as the contracts allow: one for all creator
 * earnings, one per referral asset, one for all holder rewards. Returns the last hash.
 */
export async function sendClaims(ctx: TxContext, items: ClaimRequest[]): Promise<Hash> {
  const to = account(ctx);
  const { feeVault, holderRewardDistributor } = ctx.deployment;
  const requests: Array<() => Promise<Request>> = [];

  const creatorCoins = [...new Set(items.filter((i) => i.kind === "creator").map((i) => i.coin))];
  if (creatorCoins.length > 0) {
    requests.push(async () =>
      (await ctx.client.simulateContract({ account: ctx.wallet.account, address: feeVault, abi: feeVaultAbi, functionName: "claimCreatorMany", args: [creatorCoins, to] }))
        .request as Request,
    );
  }
  for (const currency of new Set(items.filter((i) => i.kind === "referral").map((i) => i.currency))) {
    requests.push(async () =>
      (await ctx.client.simulateContract({ account: ctx.wallet.account, address: feeVault, abi: feeVaultAbi, functionName: "claimReferral", args: [currency, to] }))
        .request as Request,
    );
  }
  const holders = items.filter((i) => i.kind === "holders");
  if (holders.length > 0) {
    const claims = holders.map((i) => {
      if (i.epoch === undefined || i.index === undefined || !i.proof) throw new TxError("These rewards are missing their proof. Refresh and try again.", "reverted");
      return { epoch: BigInt(i.epoch), coin: i.coin, index: i.index, account: to, amount: i.amount, proof: i.proof };
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
    let request: Request;
    try {
      request = await build();
    } catch (error) {
      throw toTxError(error, CLAIM_FALLBACK);
    }
    last = (await submit(ctx, request, CLAIM_FALLBACK)).hash;
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
