/**
 * The real transaction code against a real memefun: a local base-anvil with DevDeploy.s.sol and
 * the seeded market (apps/memefun-backend: `pnpm dev:chain`). Every action the app sends, from a
 * brand-new wallet, as a person would: buys and sells with permits, a stock pair, launches with
 * a first buy, a creator claim, the test-stock faucet and the owner's settings.
 *
 *   cd apps/memefun-backend && pnpm dev:chain     (keep it running)
 *   cd apps/memefun && pnpm test:local
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseAbi,
  parseEther,
  parseUnits,
  zeroAddress,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { feeOnAmount } from "@/core/fees";
import type { MemefunDeployment } from "@/lib/contracts/deployments";
import { TxError } from "@/lib/market/Market";
import { MAX_TICK_DRIFT, sendClaims, sendDrip, sendLaunch, sendOwnerCalls, sendTrade, type TxContext } from "./tx";
import { REVERT_MESSAGES } from "./txErrors";

const RPC = process.env.MEMEFUN_LOCAL_RPC ?? "http://127.0.0.1:8545";
const chain = defineChain({ id: 31337, name: "Local chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const deployment = JSON.parse(readFileSync(resolve(__dirname, "../../../../../packages/memefun-contracts/deployments/31337.json"), "utf8")) as MemefunDeployment;
const client = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, transport: http(RPC), mode: "anvil" });
const owner = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 0 });

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const hookAbi = parseAbi(["function creatorOf(address coin) view returns (address)"]);

function contextFor(account: ReturnType<typeof privateKeyToAccount> | typeof owner): TxContext {
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  return { wallet, client: client as never, deployment, dataSuffix: "0x6d656d6566756e" };
}

async function deadline() {
  return (await client.getBlock()).timestamp + 1_200n;
}

async function balanceOf(token: Address, holder: Address) {
  return token === zeroAddress ? client.getBalance({ address: holder }) : client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
}

const person = privateKeyToAccount(generatePrivateKey());
const ctx = contextFor(person);
let ethCoin: Address;
let usdcCoin: Address;

beforeAll(async () => {
  const id = await client.getChainId().catch(() => null);
  if (id !== 31337) throw new Error(`No local memefun chain on ${RPC}. Start it with \`pnpm dev:chain\` in apps/memefun-backend.`);
  await testClient.setBalance({ address: person.address, value: parseEther("100") });
  // Test USDC is mintable by anyone on the local chain.
  const minter = createWalletClient({ account: owner, chain, transport: http(RPC) });
  await client.waitForTransactionReceipt({
    hash: await minter.writeContract({ address: deployment.usdc, abi: mintAbi, functionName: "mint", args: [person.address, parseUnits("10000", 6)] }),
  });
});

describe("memefun transactions on a local chain", () => {
  it("launches an ETH coin with a first buy, and the creator owns it", async () => {
    const before = await client.getBalance({ address: person.address });
    const launched = await sendLaunch(ctx, {
      name: "Local Toad",
      symbol: "LTOAD",
      contractURI: "ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
      quote: zeroAddress,
      quoteDecimals: 18,
      mode: "creator",
      feeBps: 100,
      creatorKeepBps: 0,
      firstBuy: parseEther("0.05"),
      slippageBps: 500,
      deadline: await deadline(),
    });
    ethCoin = launched.coin;
    expect(launched.coinsBought).toBeGreaterThan(0n);
    expect(await balanceOf(ethCoin, person.address)).toBe(launched.coinsBought);
    expect(await client.readContract({ address: deployment.hook, abi: hookAbi, functionName: "creatorOf", args: [ethCoin] })).toBe(person.address);
    expect(before - (await client.getBalance({ address: person.address }))).toBeGreaterThanOrEqual(parseEther("0.05"));
    expect(MAX_TICK_DRIFT).toBe(400);
  });

  it("launches a USDC coin, approving the factory for exactly the first buy", async () => {
    const launched = await sendLaunch(ctx, {
      name: "Local Frog",
      symbol: "LFROG",
      contractURI: "",
      quote: deployment.usdc,
      quoteDecimals: 6,
      mode: "holders",
      feeBps: 200,
      creatorKeepBps: 2_500,
      firstBuy: parseUnits("25", 6),
      slippageBps: 500,
      deadline: await deadline(),
    });
    usdcCoin = launched.coin;
    expect(launched.quoteSpent).toBe(parseUnits("25", 6));
    expect(await client.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "allowance", args: [person.address, deployment.factory] })).toBe(0n);
  });

  it("buys with ETH", async () => {
    const fill = await sendTrade(ctx, { side: "buy", coin: ethCoin, quote: zeroAddress, amountIn: parseEther("0.01"), minAmountOut: 1n, deadline: await deadline() });
    expect(fill.isBuy).toBe(true);
    expect(fill.quoteAmount).toBe(parseEther("0.01"));
    // Seconds after launch, so launch protection may still add to the 1% fee; either way the fee is
    // exactly the rate the hook reports, rounded up.
    expect(fill.feeBps).toBeGreaterThanOrEqual(100);
    expect(fill.feeBps).toBeLessThanOrEqual(5_000);
    expect(fill.fee).toBe(feeOnAmount(parseEther("0.01"), fill.feeBps));
  });

  it("buys with USDC through a permit: one signature, one transaction, no approval left behind", async () => {
    const nonceBefore = await client.getTransactionCount({ address: person.address });
    const fill = await sendTrade(ctx, { side: "buy", coin: usdcCoin, quote: deployment.usdc, amountIn: parseUnits("10", 6), minAmountOut: 1n, deadline: await deadline() });
    expect(fill.coinAmount).toBeGreaterThan(0n);
    expect(await client.getTransactionCount({ address: person.address })).toBe(nonceBefore + 1);
    expect(await client.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "allowance", args: [person.address, deployment.router] })).toBe(0n);
  });

  it("sells a B20 coin through its permit", async () => {
    const held = await balanceOf(ethCoin, person.address);
    const nonceBefore = await client.getTransactionCount({ address: person.address });
    const fill = await sendTrade(ctx, { side: "sell", coin: ethCoin, quote: zeroAddress, amountIn: held / 2n, minAmountOut: 1n, deadline: await deadline() });
    expect(fill.isBuy).toBe(false);
    expect(fill.coinAmount).toBe(held / 2n);
    expect(await client.getTransactionCount({ address: person.address })).toBe(nonceBefore + 1);
  });

  it("refuses a trade the price no longer allows, before it reaches the wallet", async () => {
    const error = await sendTrade(ctx, { side: "buy", coin: ethCoin, quote: zeroAddress, amountIn: parseEther("0.01"), minAmountOut: 10n ** 40n, deadline: await deadline() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TxError);
    expect((error as TxError).message).toBe(REVERT_MESSAGES.InsufficientOutput!.message);
  });

  it("gets test stock from the faucet once a day, and buys a stock-paired coin with it", async () => {
    if (!deployment.stockFaucet || !deployment.stock) throw new Error("this local deployment has no test stock faucet; restart pnpm dev:chain");
    await sendDrip(ctx);
    expect(await balanceOf(deployment.stock, person.address)).toBe(10n * 10n ** 8n);
    const again = await sendDrip(ctx).catch((e: unknown) => e);
    expect((again as TxError).message).toBe(REVERT_MESSAGES.TooSoon!.message);

    const stockCoin = (await sendLaunch(ctx, {
      name: "Local Ape",
      symbol: "LAPE",
      contractURI: "",
      quote: deployment.stock,
      quoteDecimals: 8,
      mode: "floor",
      feeBps: 300,
      creatorKeepBps: 0,
      firstBuy: 0n,
      slippageBps: 500,
      deadline: await deadline(),
    })).coin;
    const fill = await sendTrade(ctx, { side: "buy", coin: stockCoin, quote: deployment.stock, amountIn: 10n ** 8n, minAmountOut: 1n, deadline: await deadline() });
    expect(fill.coinAmount).toBeGreaterThan(0n);
  });

  it("claims creator earnings in one transaction", async () => {
    const before = await client.getBalance({ address: person.address });
    const hash = await sendClaims(ctx, [{ kind: "creator", coin: ethCoin, currency: zeroAddress, amount: 1n }]);
    const receipt = await client.getTransactionReceipt({ hash });
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    expect((await client.getBalance({ address: person.address })) + gas).toBeGreaterThan(before);
    const twice = await sendClaims(ctx, [{ kind: "creator", coin: ethCoin, currency: zeroAddress, amount: 1n }]).catch((e: unknown) => e);
    expect(twice).toBeInstanceOf(TxError);
  });

  it("lets only the owner change settings", async () => {
    const call = { fn: "setLaunchesPaused", args: ["false"], summary: "Resume new launches" };
    const refused = await sendOwnerCalls(ctx, [call]).catch((e: unknown) => e);
    expect((refused as TxError).message).toBe(REVERT_MESSAGES.OwnableUnauthorizedAccount!.message);
    const hashes = await sendOwnerCalls(contextFor(owner), [call]);
    expect(hashes).toHaveLength(1);
  });

  it("appends the builder code to every transaction", async () => {
    const fill = await sendTrade(ctx, { side: "buy", coin: ethCoin, quote: zeroAddress, amountIn: parseEther("0.001"), minAmountOut: 1n, deadline: await deadline() });
    const tx = await client.getTransaction({ hash: fill.hash });
    expect(tx.input.endsWith("6d656d6566756e")).toBe(true);
  });
});
