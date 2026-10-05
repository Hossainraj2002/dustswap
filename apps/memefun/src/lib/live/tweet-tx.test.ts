import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AUTHOR_VERIFICATION_TYPES, TWEET_LAUNCH_TYPES, type AuthorVerification, type TweetLaunchAttestation } from "@/core/tweet";
import { memeFunFactoryAbi } from "@/lib/contracts/abis";
import { DATA_SUFFIX } from "@/lib/wallet/builderCode";
import { sendAuthorVerification, sendClaims, sendLaunch, sendTreasuryAuthorWithdrawal, type TxContext } from "./tx";

const USER = "0x00000000000000000000000000000000000000aa" as const;
const PAYOUT = "0x00000000000000000000000000000000000000bb" as const;
const ERC20 = "0x00000000000000000000000000000000000000cc" as const;
const ERC20_FIRST_BUY = 1_000_000n;
const COIN = "0xb200000000000000000000000000000000000001" as const;
const HASH = `0x${"12".repeat(32)}` as const;
const SALT = `0x${"34".repeat(32)}` as const;
const POOL = `0x${"01".repeat(32)}` as const;
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const source = { postId: "123", url: "https://x.com/author/status/123", text: "#MoonCat", author: { id: "456", handle: "author", name: "Author" }, photos: [], suggestedName: "MoonCat", suggestedTicker: "MOONCAT", authorFeesSupported: true };

interface Call { address?: string; functionName: string; args?: readonly unknown[]; value?: bigint; dataSuffix?: string }
function context() {
  const token = { balance: 2n * ERC20_FIRST_BUY, allowance: 0n };
  const firstBuy = (call: Call) => {
    if (call.functionName !== "launchTweetMulti") return 0n;
    const pairs = call.args?.[1] as Array<{ quote: string; firstBuyAmount: bigint }>;
    return pairs.find(pair => pair.quote === ERC20)?.firstBuyAmount ?? 0n;
  };
  const simulate = vi.fn(async (call: Call) => {
    const amount = firstBuy(call);
    if (amount > token.balance || amount > token.allowance) throw new Error("insufficient ERC20 balance or allowance");
    return { request: call };
  });
  const write = vi.fn(async (call: Call) => {
    if (call.functionName === "approve" && call.address === ERC20) {
      if (call.args?.[0] !== USER) throw new Error("wrong factory spender");
      token.allowance = call.args[1] as bigint;
    } else {
      const amount = firstBuy(call);
      token.balance -= amount;
      token.allowance -= amount;
    }
    return HASH;
  });
  const record = { poolId: POOL, mode: 0, module: zeroAddress, feeBps: 100n, platformShareBps: 2000n, referralShareBps: 2500n,
    creatorKeepBps: 0n, protectionStartBps: 5000n, protectionDurationSec: 15n, startTick: 202000, liquidity: 1n,
    quoteUsdE8: 100000000n, openingFdvUsdE8: 500000000000n, firstBuyQuote: 0n, firstBuyCoins: 0n };
  const recordType = "(bytes32 poolId,uint8 mode,address module,uint256 feeBps,uint256 platformShareBps,uint256 referralShareBps,uint256 creatorKeepBps,uint256 protectionStartBps,uint256 protectionDurationSec,int24 startTick,uint128 liquidity,uint256 quoteUsdE8,uint256 openingFdvUsdE8,uint256 firstBuyQuote,uint256 firstBuyCoins) record";
  const logs = [{ address: USER, topics: encodeEventTopics({ abi: memeFunFactoryAbi, eventName: "Launched", args: { coin: COIN, creator: USER, quote: zeroAddress } }),
    data: encodeAbiParameters(parseAbiParameters(`string name,string symbol,string contractURI,${recordType}`), ["MoonCat", "MOONCAT", "ipfs://metadata", record]) }];
  const ctx = { wallet: { account: { address: USER, type: "local" }, writeContract: write },
    client: { simulateContract: simulate, getBlock: async () => ({ timestamp: 100n }),
      readContract: async (call: Call) => {
        if (call.functionName === "launchTerms") return { creationFee: 10n ** 16n, launchesPaused: false };
        if (call.functionName === "predictCoin") return COIN;
        if (call.functionName === "quotePriceUsdE8") return call.args?.[0] === ERC20 ? 100000000n : 300000000000n;
        if (call.functionName === "openingFdvUsdE8") return 500000000000n;
        if (call.functionName === "tweetAttestor") return signer.address;
        if (call.functionName === "treasury") return USER;
        if (call.functionName === "allowance") return token.allowance;
        if (call.functionName === "balanceOf") return token.balance;
        throw new Error("unsupported read");
      }, waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 7n, logs }) },
    deployment: { chainId: 31337, config: USER, factory: USER, hook: USER, router: USER, feeVault: USER, holderRewardDistributor: USER },
  } as unknown as TxContext;
  return { ctx, simulate, write, token };
}

async function attestation(): Promise<TweetLaunchAttestation> {
  const signature = await signer.signTypedData({ domain: { name: "MemeFunFactory", version: "1", chainId: 31337, verifyingContract: USER },
    primaryType: "TweetLaunch", types: TWEET_LAUNCH_TYPES, message: { launcher: USER, salt: SALT, postId: 123n, authorXUserId: 456n, authorShareBps: 5000, deadline: 1000n } });
  return { source, launcher: USER, salt: SALT, tweet: { postId: "123", authorXUserId: "456", authorShareBps: 5000 }, deadline: "1000", signature, chainId: 31337, factory: USER, reserveDays: 180 };
}
const launch = (tweet: TweetLaunchAttestation) => ({ name: "MoonCat", symbol: "MOONCAT", contractURI: "ipfs://metadata", quote: zeroAddress,
  quoteDecimals: 18, mode: "creator" as const, feeBps: 100, creatorKeepBps: 0, firstBuy: 0n, slippageBps: 500, deadline: 10000n, salt: SALT, tweet });
const erc20Launch = (tweet: TweetLaunchAttestation) => ({ ...launch(tweet), pairs: [
  { quote: zeroAddress, quoteDecimals: 18, firstBuy: 0n },
  { quote: ERC20, quoteDecimals: 6, firstBuy: ERC20_FIRST_BUY },
] });

describe("tweet transaction authorization", () => {
  it("uses the atomic tweet entry even for one pool with exact immutable author terms", async () => {
    const { ctx, simulate, write } = context();
    await sendLaunch(ctx, launch(await attestation()));
    const call = simulate.mock.calls[0]![0];
    expect(call.functionName).toBe("launchTweetMulti");
    expect(call.args?.[2]).toEqual({ postId: 123n, authorXUserId: 456n, authorShareBps: 5000 });
    expect(write.mock.calls[0]![0].dataSuffix).toBe(DATA_SUFFIX);
  });
  it("approves an exact ERC20 first buy before a correctly authorized two-pool launch", async () => {
    const { ctx, simulate, write, token } = context();
    expect(token.allowance).toBe(0n);
    await sendLaunch(ctx, erc20Launch(await attestation()));
    expect(simulate.mock.calls.map(([call]) => call.functionName)).toEqual(["approve", "launchTweetMulti"]);
    expect(write.mock.calls.map(([call]) => call.functionName)).toEqual(["approve", "launchTweetMulti"]);
    expect(simulate.mock.calls[0]![0]).toMatchObject({ address: ERC20, args: [USER, ERC20_FIRST_BUY] });
    expect(token).toEqual({ balance: ERC20_FIRST_BUY, allowance: 0n });
    expect(write.mock.calls.map(([call]) => call.dataSuffix)).toEqual([DATA_SUFFIX, DATA_SUFFIX]);
  });
  it.each(["launcher", "chainId", "factory", "salt", "deadline", "expiredDeadline", "share", "authorId", "postId", "signature"])("rejects changed %s before an ERC20 first-buy approval or wallet transaction", async (field) => {
    const signed = await attestation();
    if (field === "launcher") signed.launcher = PAYOUT;
    if (field === "chainId") signed.chainId = 8453;
    if (field === "factory") signed.factory = PAYOUT;
    if (field === "salt") signed.salt = HASH;
    if (field === "deadline") signed.deadline = "999";
    if (field === "expiredDeadline") signed.deadline = "99";
    if (field === "share") signed.tweet.authorShareBps = 10000;
    if (field === "authorId") {
      signed.tweet.authorXUserId = "999";
      signed.source = { ...signed.source, author: { ...signed.source.author, id: "999" } };
    }
    if (field === "postId") {
      signed.tweet.postId = "999";
      signed.source = { ...signed.source, postId: "999" };
    }
    if (field === "signature") signed.signature = "0x1234";
    const { ctx, simulate, write, token } = context();
    await expect(sendLaunch(ctx, erc20Launch(signed))).rejects.toThrow();
    expect(simulate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(token).toEqual({ balance: 2n * ERC20_FIRST_BUY, allowance: 0n });
  });
  it("binds an author wallet using the vault domain and rejects a transplanted coin signature", async () => {
    const value: AuthorVerification = { coin: COIN, authorXUserId: "456", wallet: USER, deadline: "1000", signature: "0x", chainId: 31337, feeVault: USER };
    value.signature = await signer.signTypedData({ domain: { name: "MemeFunFeeVault", version: "1", chainId: 31337, verifyingContract: USER }, primaryType: "AuthorVerification", types: AUTHOR_VERIFICATION_TYPES,
      message: { coin: COIN, authorXUserId: 456n, wallet: USER, deadline: 1000n } });
    const { ctx, simulate, write } = context();
    await sendAuthorVerification(ctx, value);
    expect(simulate.mock.calls[0]![0].functionName).toBe("verifyAuthor");
    expect(write.mock.calls[0]![0].dataSuffix).toBe(DATA_SUFFIX);
    const second = context();
    await expect(sendAuthorVerification(second.ctx, { ...value, coin: PAYOUT })).rejects.toThrow();
    expect(second.write).not.toHaveBeenCalled();
  });
  it("keeps author payouts bound to the verified wallet even when creator payout differs", async () => {
    const { ctx, simulate, write } = context();
    await sendClaims(ctx, [{ kind: "author", coin: COIN, poolId: POOL, currency: zeroAddress, amount: 1n }, { kind: "author", coin: COIN, poolId: POOL, currency: zeroAddress, amount: 1n }], PAYOUT);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate.mock.calls[0]![0]).toMatchObject({ functionName: "claimAuthorFor", args: [COIN, zeroAddress, USER] });
    expect(write.mock.calls[0]![0].dataSuffix).toBe(DATA_SUFFIX);
  });
  it.each([zeroAddress, ERC20])("withdraws treasury rewards in %s without accepting a payout address", async (currency) => {
    const { ctx, simulate, write } = context();
    await expect(sendTreasuryAuthorWithdrawal(ctx, COIN, currency)).resolves.toBe(HASH);
    expect(simulate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ address: USER, functionName: "reclaimExpiredAuthorFor", args: [COIN, currency] }));
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0].dataSuffix).toBe(DATA_SUFFIX);
  });
  it("rejects a wallet that is no longer the treasury before simulation or signing", async () => {
    const { ctx, simulate, write } = context();
    Object.assign(ctx.wallet, { account: { address: PAYOUT } });
    await expect(sendTreasuryAuthorWithdrawal(ctx, COIN, zeroAddress)).rejects.toThrow("current DustSwap treasury");
    expect(simulate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("never requests a signature for a withdrawal that the vault rejects", async () => {
    const { ctx, simulate, write } = context();
    simulate.mockRejectedValueOnce(new Error("180-day lock or empty shared reserve"));
    await expect(sendTreasuryAuthorWithdrawal(ctx, COIN, zeroAddress)).rejects.toThrow("withdrawal did not go through");
    expect(write).not.toHaveBeenCalled();
  });
  it("reports a reverted receipt as a failed treasury withdrawal", async () => {
    const { ctx } = context();
    Object.assign(ctx.client, { waitForTransactionReceipt: async () => ({ status: "reverted", logs: [] }) });
    await expect(sendTreasuryAuthorWithdrawal(ctx, COIN, zeroAddress)).rejects.toThrow("withdrawal did not go through");
  });
});
