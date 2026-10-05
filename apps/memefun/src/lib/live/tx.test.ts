import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, zeroAddress } from "viem";
import { COIN_SUPPLY } from "@/core/constants";
import { memeFunFactoryAbi, memeFunHookAbi } from "@/lib/contracts/abis";
import { ETH, USDC } from "@/lib/market/quotes";
import { sendClaims, sendCreatorAction, sendDrip, sendLaunch, sendOwnerCalls, sendTrade, type TxContext } from "./tx";
import { DATA_SUFFIX } from "@/lib/wallet/builderCode";

const USER = "0x00000000000000000000000000000000000000aa" as const;
const PAYOUT = "0x00000000000000000000000000000000000000bb" as const;
const COIN = "0xb200000000000000000000000000000000000001" as const;
const HASH = `0x${"12".repeat(32)}` as const;
const POOLS = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`] as const;
const RECORD = "(bytes32 poolId,uint8 mode,address module,uint256 feeBps,uint256 platformShareBps,uint256 referralShareBps,uint256 creatorKeepBps,uint256 protectionStartBps,uint256 protectionDurationSec,int24 startTick,uint128 liquidity,uint256 quoteUsdE8,uint256 openingFdvUsdE8,uint256 firstBuyQuote,uint256 firstBuyCoins) record";
const record = (i: number) => ({ poolId: POOLS[i]!, mode: 0, module: zeroAddress, feeBps: 100n, platformShareBps: 2000n,
  referralShareBps: 2500n, creatorKeepBps: 0n, protectionStartBps: 5000n, protectionDurationSec: 15n, startTick: 202000,
  liquidity: 1n, quoteUsdE8: 100000000n, openingFdvUsdE8: 500000000000n, firstBuyQuote: 0n, firstBuyCoins: 10n });

interface Call { functionName: string; args?: readonly unknown[]; value?: bigint; dataSuffix?: string }
function context(logs: unknown[], allowance = 0n) {
  const simulate = vi.fn(async (call: Call) => ({ request: call }));
  const write = vi.fn(async (_call: Call) => HASH);
  const ctx = {
    wallet: { account: { address: USER, type: "local" }, writeContract: write },
    client: { simulateContract: simulate,
      readContract: async (call: Call) => {
        if (call.functionName === "launchTerms") return { creationFee: 10n ** 16n, launchesPaused: false };
        if (call.functionName === "predictCoin") return COIN;
        if (call.functionName === "quotePriceUsdE8") return call.args?.[0] === zeroAddress ? 300000000000n : 100000000n;
        if (call.functionName === "openingFdvUsdE8") return 500000000000n;
        if (call.functionName === "allowance") return allowance;
        if (call.functionName === "owner") return USER;
        throw new Error("not supported");
      }, waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 7n, logs }) },
    deployment: { config: USER, factory: USER, hook: USER, router: USER, feeVault: USER, holderRewardDistributor: USER, stockFaucet: USER },
  } as unknown as TxContext;
  return { ctx, simulate, write };
}

describe("multi-market transaction boundaries", () => {
  it("creates one token in one launchMulti call, with allocated slippage and exact first-buy approval", async () => {
    const launchData = encodeAbiParameters(parseAbiParameters(`string name,string symbol,string contractURI,${RECORD}`), ["One", "ONE", "ipfs://metadata", record(0)]);
    const logs = [{ address: USER, topics: encodeEventTopics({ abi: memeFunFactoryAbi, eventName: "Launched", args: { coin: COIN, creator: USER, quote: zeroAddress } }), data: launchData },
      ...POOLS.map((poolId, i) => ({ address: USER, topics: encodeEventTopics({ abi: memeFunFactoryAbi, eventName: "MarketLaunched", args: { coin: COIN, quote: i === 0 ? zeroAddress : USDC.address, poolId } }),
        data: encodeAbiParameters(parseAbiParameters(`uint256 allocation,uint256 deposited,${RECORD}`), [COIN_SUPPLY / 2n, COIN_SUPPLY / 2n, record(i)]) }))];
    const { ctx, simulate, write } = context(logs);
    const result = await sendLaunch(ctx, { name: "One", symbol: "ONE", contractURI: "ipfs://metadata", quote: ETH.address, quoteDecimals: 18,
      mode: "creator", feeBps: 100, creatorKeepBps: 0, firstBuy: 0n, slippageBps: 500, deadline: 10000n,
      pairs: [{ quote: ETH.address, quoteDecimals: 18, firstBuy: 0n }, { quote: USDC.address, quoteDecimals: 6, firstBuy: 25000000n }] });
    expect(result.coin).toBe(COIN);
    expect(result.markets?.map((market) => market.poolId)).toEqual(POOLS);
    const calls = simulate.mock.calls.map(([call]) => call);
    expect(calls.map((call) => call.functionName)).toEqual(["approve", "launchMulti"]);
    expect(calls[0]!.args).toEqual([USER, 25000000n]);
    const [base, pairs] = calls[1]!.args as [{ quote: string; firstBuyAmount: bigint; firstBuyMinCoins: bigint; expectedStartTick: number }, Array<{ quote: string; firstBuyAmount: bigint; firstBuyMinCoins: bigint; expectedStartTick: number }>];
    expect(base.quote).toBe(pairs[0]!.quote);
    expect(base.firstBuyAmount).toBe(0n);
    expect(pairs[1]!.firstBuyAmount).toBe(25000000n);
    expect(pairs[1]!.firstBuyMinCoins).toBeGreaterThan(0n);
    expect(pairs[1]!.firstBuyMinCoins).toBeLessThan(COIN_SUPPLY / 2n);
    expect(calls[1]!.value).toBe(10n ** 16n);
    expect(write.mock.calls.map(([call]) => call.dataSuffix)).toEqual([DATA_SUFFIX, DATA_SUFFIX]);
  });

  it("routes an explicit selected quote into buyFor instead of the primary wrapper", async () => {
    const data = encodeAbiParameters(parseAbiParameters("bool isBuy,uint256 quoteAmount,uint256 coinAmount,uint256 fee,uint256 feeBps,address referrer,uint160 sqrtPriceX96,int24 tick"), [true, 100n, 1000n, 1n, 100n, zeroAddress, 2n ** 96n, 0]);
    const topics = encodeEventTopics({ abi: memeFunHookAbi, eventName: "Trade", args: { id: POOLS[1], coin: COIN, trader: USER } });
    const { ctx, simulate, write } = context([{ address: USER, topics, data }], 10000000n);
    await sendTrade(ctx, { side: "buy", coin: COIN, quote: USDC.address, explicitPool: true, amountIn: 100n, minAmountOut: 1n, deadline: 10000n });
    expect(simulate.mock.calls[0]![0].functionName).toBe("buyFor");
    expect(simulate.mock.calls[0]![0].args?.[1]).toBe(USDC.address);
    expect(simulate.mock.calls[0]![0].value).toBe(0n);
    expect(write.mock.calls[0]![0].dataSuffix).toBe(DATA_SUFFIX);
  });

  it("pays creator/referral rewards to the chosen wallet while holder proof account remains the earner", async () => {
    const { ctx, simulate, write } = context([]);
    await sendClaims(ctx, [
      { kind: "creator", coin: COIN, poolId: POOLS[0], currency: ETH.address, amount: 1n },
      { kind: "creator", coin: COIN, poolId: POOLS[1], currency: USDC.address, amount: 1n },
      { kind: "referral", coin: COIN, currency: USDC.address, amount: 1n },
      { kind: "holders", coin: COIN, poolId: POOLS[1], currency: USDC.address, amount: 1n, epoch: 3, index: 0n, proof: [] },
    ], PAYOUT);
    const calls = simulate.mock.calls.map(([call]) => call);
    expect(calls.map((call) => call.functionName)).toEqual(["claimCreatorFor", "claimCreatorFor", "claimReferral", "claimManyFor"]);
    expect(calls[0]!.args).toEqual([COIN, ETH.address, PAYOUT]);
    expect(calls[1]!.args).toEqual([COIN, USDC.address, PAYOUT]);
    const claims = calls[3]!.args?.[0] as Array<{ poolId: string; account: string }>;
    expect(claims[0]).toMatchObject({ poolId: POOLS[1], account: USER });
    expect(write.mock.calls.map(([call]) => call.dataSuffix)).toEqual(Array(4).fill(DATA_SUFFIX));
  });

  it("retains the confirmed hash and explains partial payouts if a later claim fails", async () => {
    const { ctx, simulate, write } = context([]);
    simulate.mockImplementationOnce(async (call) => ({ request: call })).mockImplementationOnce(async () => { throw new Error("later claim failed"); });
    const error = await sendClaims(ctx, [
      { kind: "creator", coin: COIN, poolId: POOLS[0], currency: ETH.address, amount: 1n },
      { kind: "creator", coin: COIN, poolId: POOLS[1], currency: USDC.address, amount: 1n },
    ]).catch((failure: unknown) => failure);
    expect(write).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ hash: HASH });
    expect((error as Error).message).toContain("Earlier claims confirmed");
  });
});

describe("mandatory attribution for management transactions", () => {
  it.each(["lowerFee", "proposeCreator", "acceptCreator"] as const)("attributes the %s creator action without requiring callers to provide a suffix", async action => {
    const { ctx, write } = context([]);
    await sendCreatorAction(ctx, COIN, action, action === "lowerFee" ? 100 : PAYOUT);
    expect(write.mock.calls[0]![0].dataSuffix).toBe(DATA_SUFFIX);
  });

  it("attributes faucet and every owner setter", async () => {
    const { ctx, write } = context([]);
    await sendDrip(ctx);
    await sendOwnerCalls(ctx, [
      { fn: "setLaunchesPaused", args: ["true"], summary: "Pause launches" },
      { fn: "setLaunchesPaused", args: ["false"], summary: "Resume launches" },
    ]);
    expect(write.mock.calls.map(([call]) => call.dataSuffix)).toEqual(Array(3).fill(DATA_SUFFIX));
  });

  it.each(["0x", "0x1234"] as const)("rejects an empty or different context suffix %s before a wallet transaction", async suffix => {
    const { ctx, write } = context([]);
    ctx.dataSuffix = suffix;
    await expect(sendCreatorAction(ctx, COIN, "acceptCreator")).rejects.toThrow("builder code does not match DustSwap");
    expect(write).not.toHaveBeenCalled();
  });
});
