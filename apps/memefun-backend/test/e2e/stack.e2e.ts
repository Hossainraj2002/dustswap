import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import pg from "pg";
import sharp from "sharp";
import { encodeAbiParameters, erc20Abi, keccak256, maxUint256, parseEther, toHex, zeroAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createKeeperContext, type KeeperContext } from "../../keeper/context";
import { runEpochs } from "../../keeper/jobs/epochs";
import { runMetadata } from "../../keeper/jobs/metadata";
import { runBuybacks } from "../../keeper/jobs/modules";
import { LOCAL_CHAIN_ID } from "../../lib/chain";
import { loadDeployment } from "../../lib/deployment";
import { type DevRole, devAccount, localClients } from "../../lib/dev";
import { priceUsdE18 } from "../../lib/market/math";
import { EPOCH_LENGTH_SEC, latestBoundary } from "../../lib/rewards/twab";
import { verifyIndexAgainstChain } from "../../lib/verify/chain-truth";
import { COIN_SUPPLY } from "../../shared/core/constants";
import { AUTHOR_VERIFICATION_TYPES, TWEET_LAUNCH_TYPES } from "../../shared/core/tweet";
import { livePool, quoteBuy, quoteSell } from "../../shared/core/pool";
import { activeLiquidity } from "../../shared/core/uniswap/swap";
import { feeVaultAbi, holderRewardDistributorAbi, memeFunConfigAbi, memeFunFactoryAbi, memeFunHookAbi, memeFunRouterAbi } from "../../shared/abis";

const e2e = inject("e2e");
const d = loadDeployment(LOCAL_CHAIN_ID);
const { publicClient, testClient, wallet } = localClients(e2e.rpcUrl);
let indexPool: pg.Pool;
let keeper: KeeperContext;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> {
  const response = await fetch(e2e.apiUrl + path, { ...init, headers: { origin: e2e.origin, ...(init.headers ?? {}) } });
  const text = await response.text();
  return { status: response.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text };
}

/** Waits until Ponder has indexed `block` (its checkpoint carries the block number) and the API refreshed. */
async function waitIndexed(block: bigint) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { rows } = await indexPool.query<{ latest_checkpoint: string }>(`SELECT latest_checkpoint FROM "${e2e.schema}"._ponder_checkpoint`);
    const indexed = rows[0] ? BigInt(rows[0].latest_checkpoint.slice(26, 42)) : -1n;
    if (indexed >= block) break;
    if (Date.now() > deadline) throw new Error(`index stuck at block ${indexed}, wanted ${block}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 2_500)); // one snapshot refresh
}

async function send(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

async function chainNow() {
  return Number((await publicClient.getBlock()).timestamp);
}

async function warpTo(timestamp: number) {
  await testClient.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
  await testClient.mine({ blocks: 1 });
}

async function coinBySymbol(symbol: string): Promise<Json> {
  const { body } = await api(`/v1/search?q=${symbol}`);
  const coin = body.coins.find((c: Json) => c.symbol === symbol);
  if (!coin) throw new Error(`no coin ${symbol}`);
  return coin;
}

async function verifyIndex() {
  const report = await verifyIndexAgainstChain({ pool: indexPool, schema: e2e.schema, client: publicClient as never, deployment: d });
  expect(report.failures).toEqual([]);
  return report;
}

beforeAll(async () => {
  Object.assign(process.env, {
    MEMEFUN_CHAIN: "local",
    MEMEFUN_RPC_URLS: e2e.rpcUrl,
    DATABASE_URL: e2e.databaseUrl,
    DATABASE_SCHEMA: e2e.schema,
    MEDIA_STORE: "local",
    MEDIA_LOCAL_DIR: e2e.mediaDir,
    PUBLIC_API_URL: e2e.apiUrl,
    KEEPER_DRY_RUN: "false",
  });
  indexPool = new pg.Pool({ connectionString: e2e.databaseUrl, max: 4 });
  keeper = createKeeperContext();
  await waitIndexed(await publicClient.getBlockNumber());
});

afterAll(async () => {
  await Promise.allSettled([indexPool?.end(), keeper?.index.end(), keeper?.appPool.end()]);
});

describe("memefun backend, end to end", () => {
  it("the index equals the chain after seeding", async () => {
    const report = await verifyIndex();
    expect(report.coins).toBe(6);
    expect(report.checks).toBeGreaterThan(150);
  });

  it("the API serves the market as the chain has it", async () => {
    const { status, body } = await api("/v1/coins?sort=new&limit=50");
    expect(status).toBe(200);
    expect(body.total).toBe(6);

    for (const coin of body.coins as Json[]) {
      // Price: straight from the pool's slot0 at the latest block, valued at the dev ETH/USD price.
      const config = await publicClient.readContract({ address: d.hook, abi: [{ type: "function", name: "configOf", stateMutability: "view", inputs: [{ name: "coin", type: "address" }], outputs: [{ name: "", type: "tuple", components: [{ name: "coin", type: "address" }, { name: "quoteIsCurrency0", type: "bool" }] }] }] as const, functionName: "configOf", args: [coin.address] });
      const { rows } = await indexPool.query(`SELECT sqrt_price_x_96 FROM "${e2e.schema}".coin WHERE address = $1`, [coin.address.toLowerCase()]);
      const expected = priceUsdE18(BigInt(rows[0].sqrt_price_x_96), { quoteIsCurrency0: config.quoteIsCurrency0, quoteDecimals: coin.quote.decimals }, BigInt(Math.round(coin.quote.usdPrice * 1e8)));
      expect(coin.priceUsd / (Number(expected) / 1e18)).toBeCloseTo(1, 9);

      // Holders: every coin is accounted for, pool and burn included.
      const holders = (await api(`/v1/coins/${coin.address}/holders?limit=100`)).body.holders as Json[];
      const total = holders.reduce((sum, h) => sum + BigInt(Math.round(h.balance * 1e6)), 0n) * 10n ** 12n;
      const diff = total > COIN_SUPPLY ? total - COIN_SUPPLY : COIN_SUPPLY - total;
      expect(Number(diff) / Number(COIN_SUPPLY)).toBeLessThan(1e-9);
      if (coin.symbol !== "MOTH") expect(holders.some((h) => h.label === "pool")).toBe(true);

      // Trades: paging through every trade gives exactly the indexed count; candles close at the price.
      let cursor: string | null = null;
      let count = 0;
      do {
        const page: Json = (await api(`/v1/coins/${coin.address}/trades?limit=7${cursor ? `&before=${cursor}` : ""}`)).body;
        count += page.trades.length;
        cursor = page.nextCursor;
      } while (cursor);
      const { rows: tradeRows } = await indexPool.query(`SELECT trades FROM "${e2e.schema}".coin WHERE address = $1`, [coin.address.toLowerCase()]);
      expect(count).toBe(Number(tradeRows[0].trades));
      if (count > 0) {
        const candles = (await api(`/v1/coins/${coin.address}/candles?interval=60`)).body.candles as Json[];
        expect(candles.at(-1).close / coin.priceUsd).toBeCloseTo(1, 2);
      }
    }
  });

  it("the pool endpoint quotes exactly what the router fills", async () => {
    const pm = [
      { type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ name: "", type: "bytes32" }] },
    ] as const;
    const latest = await publicClient.getBlock();
    const deadline = latest.timestamp + 3_600n;
    const roles: DevRole[] = ["alice", "bob", "carol", "dave", "erin", "frank"];
    const approved = new Set<string>();
    const approveRouter = async (role: DevRole, token: `0x${string}`) => {
      if (approved.has(`${role}:${token}`)) return;
      await send(await wallet(role).writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [d.router, maxUint256] }));
      approved.add(`${role}:${token}`);
    };
    const simulate = async (role: DevRole, side: "buy" | "sell", coin: `0x${string}`, amountIn: bigint, value: bigint) => {
      const account = devAccount(role);
      const args = [{ coin, amountIn, minAmountOut: 0n, recipient: zeroAddress, referrer: zeroAddress, deadline }] as const;
      return side === "buy"
        ? (await publicClient.simulateContract({ account, address: d.router, abi: memeFunRouterAbi, functionName: "buy", args, value })).result
        : (await publicClient.simulateContract({ account, address: d.router, abi: memeFunRouterAbi, functionName: "sell", args })).result;
    };

    const coins = (await api("/v1/coins?sort=new&limit=50")).body.coins as Json[];
    let checked = 0;
    for (const coin of coins) {
      const { pool } = (await api(`/v1/coins/${coin.address}/pool`)).body;
      const live = livePool({
        coinIsCurrency0: pool.coinIsCurrency0,
        quoteDecimals: pool.quoteDecimals,
        startTick: pool.startTick,
        liquidity: BigInt(pool.liquidity),
        sqrtPriceX96: BigInt(pool.sqrtPriceX96),
        tick: pool.tick,
        floors: pool.floors.map((f: Json) => ({ tickLower: f.tickLower, tickUpper: f.tickUpper, liquidity: BigInt(f.liquidity) })),
      });

      // The endpoint is the chain: slot0 as the PoolManager stores it, and its positions add up to
      // the liquidity in range.
      const stateSlot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [pool.poolId, 6n]));
      const slot0 = BigInt(await publicClient.readContract({ address: d.poolManager, abi: pm, functionName: "extsload", args: [stateSlot] }));
      const inRange = BigInt(
        await publicClient.readContract({ address: d.poolManager, abi: pm, functionName: "extsload", args: [toHex(BigInt(stateSlot) + 3n, { size: 32 })] }),
      );
      expect(live.sqrtPriceX96).toBe(slot0 & ((1n << 160n) - 1n));
      expect(live.tick).toBe(Number(BigInt.asIntN(24, slot0 >> 160n)));
      const positions = [{ tickLower: live.tickLower, tickUpper: live.tickUpper, liquidity: live.liquidity }, ...(live.floors ?? [])];
      expect(activeLiquidity(positions, live.tick)).toBe(inRange);
      if (coin.symbol === "FAPE") expect(pool.floors.length).toBeGreaterThan(0);

      // Every seeded coin is past launch protection, so trades pay the base fee.
      expect(Number(latest.timestamp) - coin.createdAt / 1000).toBeGreaterThan(coin.terms.snipeDurationSec);
      const feeBps = coin.terms.feeBps as number;
      const quote = coin.quote.address as `0x${string}`;
      const isEth = quote === zeroAddress;

      // Buys worth $0.50, $50 and $5,000.
      if (!isEth) await approveRouter("alice", quote);
      for (const usd of [0.5, 50, 5_000]) {
        const amountIn = BigInt(Math.round((usd / coin.quote.usdPrice) * 10 ** coin.quote.decimals));
        const expected = quoteBuy(live, amountIn, feeBps);
        expect(expected.partial).toBe(false);
        expect(await simulate("alice", "buy", coin.address, amountIn, isEth ? amountIn : 0n)).toBe(expected.amountOut);
        checked++;
      }

      // Sells of 10%, 50% and all of the largest dev holder's balance.
      let holder: DevRole | null = null;
      let held = 0n;
      for (const role of roles) {
        const balance = await publicClient.readContract({ address: coin.address, abi: erc20Abi, functionName: "balanceOf", args: [devAccount(role).address] });
        if (balance > held) [holder, held] = [role, balance];
      }
      if (!holder) continue;
      await approveRouter(holder, coin.address);
      for (const share of [1_000n, 5_000n, 10_000n]) {
        const amountIn = (held * share) / 10_000n;
        const expected = quoteSell(live, amountIn, feeBps);
        expect(await simulate(holder, "sell", coin.address, amountIn, 0n)).toBe(expected.amountOut);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it("the keeper resolves every coin's metadata and image", async () => {
    const result = await runMetadata(keeper);
    expect(result).toEqual({ resolved: 6, failed: 0 });
    await new Promise((r) => setTimeout(r, 2_500));
    const frog = await coinBySymbol("FROG");
    expect(frog.description).toBe("The frog that only lives on Base.");
    expect(frog.links).toEqual({ x: "frogonbase", website: "https://frog.example/" });
    const image = await fetch(frog.image);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
  });

  it("the keeper's buyback burns coins", async () => {
    const bcat = await coinBySymbol("BCAT");
    for (const who of ["carol", "dave"] as const) {
      await send(
        await wallet(who).writeContract({
          address: d.router,
          abi: memeFunRouterAbi,
          functionName: "buy",
          args: [{ coin: bcat.address, amountIn: parseEther("0.2"), minAmountOut: 0n, recipient: zeroAddress, referrer: zeroAddress, deadline: BigInt((await chainNow()) + 3_600) }],
          value: parseEther("0.2"),
        }),
      );
    }
    const deadBefore = await publicClient.readContract({ address: bcat.address, abi: erc20Abi, functionName: "balanceOf", args: ["0x000000000000000000000000000000000000dEaD"] });
    const result = await runBuybacks(keeper);
    expect(result.executed).toBe(1);
    const deadAfter = await publicClient.readContract({ address: bcat.address, abi: erc20Abi, functionName: "balanceOf", args: ["0x000000000000000000000000000000000000dEaD"] });
    expect(deadAfter > deadBefore).toBe(true);
    await waitIndexed(await publicClient.getBlockNumber());
    const after = await coinBySymbol("BCAT");
    expect(after.stats.buybacks).toBe(bcat.stats.buybacks + 1);
    expect(after.stats.burnedCoins).toBeGreaterThan(bcat.stats.burnedCoins);
  });

  it("a 12-hour epoch is published, recomputable from IPFS, and claimable with the API's proof", async () => {
    // Jump past the next 00:00/12:00 UTC boundary so the first window closes.
    const boundary = latestBoundary(await chainNow()) + EPOCH_LENGTH_SEC;
    await warpTo(boundary + 30);
    await waitIndexed(await publicClient.getBlockNumber());

    const result = await runEpochs(keeper);
    expect(result.status).toBe("published");
    expect(result.epoch).toBe(1n);
    const onchain = await publicClient.readContract({ address: d.holderRewardDistributor, abi: holderRewardDistributorAbi, functionName: "epochs", args: [1n] });
    const root = onchain[0];

    // Anyone can rebuild the root from the published leaf set.
    const { rows } = await indexPool.query(`SELECT leaves_uri FROM memefun_app.reward_epoch WHERE epoch = 1`);
    const document = (await (await fetch(`${e2e.apiUrl}/media/${String(rows[0].leaves_uri).slice(7)}`)).json()) as Json;
    expect(StandardMerkleTree.load(document.tree).root).toBe(root);

    // Claims open after the 12-hour veto window.
    await warpTo((await chainNow()) + 12 * 3_600 + 5);
    await waitIndexed(await publicClient.getBlockNumber());
    const holder = devAccount("carol").address;
    const claimables = (await api(`/v1/claimables/${holder}`)).body.claimables as Json[];
    const reward = claimables.find((c) => c.kind === "holders");
    expect(reward).toBeDefined();
    expect(reward.epoch).toBe(1);

    const usdcBefore = await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    // Anyone may submit a claim; the reward always goes to the account in the leaf.
    await send(
      await wallet("frank").writeContract({
        address: d.holderRewardDistributor,
        abi: holderRewardDistributorAbi,
        functionName: "claimFor",
        args: [{ epoch: 1n, poolId: reward.poolId, index: BigInt(reward.index), account: holder, amount: BigInt(reward.amountRaw), proof: reward.proof }],
      }),
    );
    const usdcAfter = await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    expect(usdcAfter - usdcBefore).toBe(BigInt(reward.amountRaw));

    await waitIndexed(await publicClient.getBlockNumber());
    const left = (await api(`/v1/claimables/${holder}`)).body.claimables as Json[];
    expect(left.some((c) => c.kind === "holders" && c.epoch === 1)).toBe(false);
  });

  it("image, metadata, launch, then the indexed coin shows that metadata", async () => {
    const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#22aa55" } }).png().toBuffer();
    const image = await api("/v1/media/image", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(png) });
    expect(image.status).toBe(201);
    const metadata = await api("/v1/media/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Round Trip", symbol: "TRIP", description: "Launched by the e2e suite.", image: image.body.uri, telegram: "roundtrip_chat" }),
    });
    expect(metadata.status).toBe(201);

    const dave = wallet("dave");
    const salt = keccak256(toHex("e2e-round-trip"));
    const predicted = await publicClient.readContract({ address: d.factory, abi: memeFunFactoryAbi, functionName: "predictCoin", args: [dave.account.address, salt] });
    await send(
      await dave.writeContract({
        address: d.factory,
        abi: memeFunFactoryAbi,
        functionName: "launch",
        args: [{ name: "Round Trip", symbol: "TRIP", contractURI: metadata.body.contractURI, quote: zeroAddress, mode: 0, feeBps: 100, creatorKeepBps: 0, salt, firstBuyAmount: parseEther("0.01"), firstBuyMinCoins: 0n, expectedStartTick: 0, maxTickDrift: 0xffffff, deadline: BigInt((await chainNow()) + 3_600) }],
        value: parseEther("0.01"),
      }),
    );
    await waitIndexed(await publicClient.getBlockNumber());
    const coin = (await api(`/v1/coins/${predicted}`)).body.coin;
    expect(coin).toMatchObject({ name: "Round Trip", symbol: "TRIP", description: "Launched by the e2e suite.", links: { telegram: "roundtrip_chat" } });
    expect(coin.image).toBe(image.body.url);
    expect(coin.creator).toBe(dave.account.address);
    const launch = (await api("/v1/activity?limit=50")).body.items.find((i: Json) => i.kind === "launch" && i.coin === predicted);
    expect(launch).toBeDefined();
  });

  it("sign in, comment, moderate and report", async () => {
    const alice = devAccount("alice");
    const { body: nonce } = await api("/v1/auth/nonce", { method: "POST" });
    const message = createSiweMessage({ address: alice.address, chainId: LOCAL_CHAIN_ID, domain: "localhost:3100", nonce: nonce.nonce, uri: e2e.origin, version: "1" });
    const verified = await api("/v1/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: alice.address, message, signature: await alice.signMessage!({ message }) }),
    });
    expect(verified.status).toBe(200);
    const auth = { authorization: `Bearer ${verified.body.token}`, "content-type": "application/json" };

    const frog = await coinBySymbol("FROG");
    const posted = await api(`/v1/coins/${frog.address}/comments`, { method: "POST", headers: auth, body: JSON.stringify({ body: "gm from the e2e suite" }) });
    expect(posted.status).toBe(201);
    expect(posted.body.comment.isCreator).toBe(true);
    expect((await api(`/v1/coins/${frog.address}/comments`)).body.comments.map((c: Json) => c.body)).toContain("gm from the e2e suite");

    const admin = { "x-admin-token": e2e.adminToken, "content-type": "application/json" };
    expect((await api(`/v1/admin/comments/${posted.body.comment.id}/hide`, { method: "POST", headers: admin, body: JSON.stringify({ hidden: true }) })).status).toBe(200);
    expect((await api(`/v1/coins/${frog.address}/comments`)).body.comments).toEqual([]);

    expect((await api(`/v1/admin/coins/${frog.address}/moderation`, { method: "POST", headers: admin, body: JSON.stringify({ hidden: true }) })).status).toBe(200);
    expect((await api("/v1/coins?limit=50")).body.coins.some((c: Json) => c.address === frog.address)).toBe(false);
    expect((await api(`/v1/admin/coins/${frog.address}/moderation`, { method: "POST", headers: admin, body: JSON.stringify({ hidden: false }) })).status).toBe(200);

    const report = await api("/v1/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetKind: "coin", targetId: frog.address, reason: "spam" }) });
    expect(report.status).toBe(201);
    expect((await api("/v1/admin/reports", { headers: admin })).body.reports).toHaveLength(1);
  });

  it("the live stream pushes a new trade", async () => {
    const frog = await coinBySymbol("FROG");
    const controller = new AbortController();
    const response = await fetch(`${e2e.apiUrl}/v1/stream?coin=${frog.address}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const received = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const match = /event: trade\ndata: (.*)\n/.exec(buffer);
        if (match) return JSON.parse(match[1]!);
      }
    })();
    await new Promise((r) => setTimeout(r, 1_500));
    await send(
      await wallet("erin").writeContract({
        address: d.router,
        abi: memeFunRouterAbi,
        functionName: "buy",
        args: [{ coin: frog.address, amountIn: parseEther("0.01"), minAmountOut: 0n, recipient: zeroAddress, referrer: zeroAddress, deadline: BigInt((await chainNow()) + 3_600) }],
        value: parseEther("0.01"),
      }),
    );
    const trade = await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error("no trade event within 20s")), 20_000))]);
    controller.abort();
    expect(trade).toMatchObject({ coin: frog.address, side: "buy", trader: devAccount("erin").address });
  });

  it("after everything, the index still equals the chain", async () => {
    await waitIndexed(await publicClient.getBlockNumber());
    const report = await verifyIndex();
    expect(report.coins).toBe(7);
  });

  it("one three-pair launch indexes separate trades and earnings, then transfers all creator authority", async () => {
    const creator = wallet("dave");
    const salt = keccak256(toHex("e2e-three-markets"));
    const address = await publicClient.readContract({ address: d.factory, abi: memeFunFactoryAbi, functionName: "predictCoin", args: [creator.account.address, salt] });
    const quotes = [zeroAddress, d.usdc, d.stock!] as const;
    const firstBuys = [parseEther("0.02"), 75_000_000n, 100_000_000n];
    // Earlier reward tests move chain time past the dev stock's NAV freshness window.
    const stockQuote = await publicClient.readContract({ address: d.config, abi: memeFunConfigAbi, functionName: "quote", args: [d.stock!] });
    await send(await wallet("priceKeeper").writeContract({ address: d.config, abi: memeFunConfigAbi, functionName: "setManualPrice", args: [d.stock!, stockQuote.priceUsdE8] }));
    for (const quote of quotes.slice(1)) {
      await send(await creator.writeContract({ address: quote, abi: erc20Abi, functionName: "approve", args: [d.factory, maxUint256] }));
    }
    await send(await creator.writeContract({
      address: d.factory, abi: memeFunFactoryAbi, functionName: "launchMulti",
      args: [{ name: "Three Markets", symbol: "THREE", contractURI: "ipfs://e2e-three-markets", quote: zeroAddress,
        mode: 0, feeBps: 100, creatorKeepBps: 0, salt, firstBuyAmount: firstBuys[0]!, firstBuyMinCoins: 0n,
        expectedStartTick: 0, maxTickDrift: 0xffffff, deadline: BigInt((await chainNow()) + 3_600) },
      quotes.map((quote, i) => ({ quote, firstBuyAmount: firstBuys[i]!, firstBuyMinCoins: 0n, expectedStartTick: 0, maxTickDrift: 0xffffff }))],
      value: firstBuys[0]!,
    }));
    await waitIndexed(await publicClient.getBlockNumber());
    let coin = (await api(`/v1/coins/${address}`)).body.coin;
    expect(coin.symbol).toBe("THREE");
    const markets = coin.markets as Json[];
    expect(markets).toHaveLength(3);
    expect(new Set(markets.map((m) => m.poolId)).size).toBe(3);
    expect(markets.reduce((sum, m) => sum + BigInt(m.supplyRaw), 0n)).toBe(COIN_SUPPLY);
    for (const [i, quote] of quotes.entries()) {
      const market = markets.find((m) => m.quote.address.toLowerCase() === quote.toLowerCase());
      expect(BigInt(market.supplyRaw)).toBe(i === quotes.length - 1 ? COIN_SUPPLY - 2n * (COIN_SUPPLY / 3n) : COIN_SUPPLY / 3n);
    }
    expect((await api(`/v1/coins/${address}/pools`)).body.markets).toHaveLength(3);

    // The same coin is priced independently in 18-, 6-, and 8-decimal assets.
    await warpTo((await chainNow()) + coin.terms.snipeDurationSec + 5);
    const amounts = [parseEther("0.003"), 10_000_000n, 10_000_000n];
    for (const [i, quote] of quotes.entries()) {
      const market = markets.find((m) => m.quote.address.toLowerCase() === quote.toLowerCase())!;
      const pool = (await api(`/v1/coins/${address}/pool?poolId=${market.poolId}`)).body.pool;
      expect(pool.quote.toLowerCase()).toBe(quote.toLowerCase());
      const expected = quoteBuy(livePool({ ...pool, liquidity: BigInt(pool.liquidity), sqrtPriceX96: BigInt(pool.sqrtPriceX96),
        floors: pool.floors.map((f: Json) => ({ ...f, liquidity: BigInt(f.liquidity) })) }), amounts[i]!, coin.terms.feeBps);
      if (quote !== zeroAddress) await send(await wallet("erin").writeContract({ address: quote, abi: erc20Abi, functionName: "approve", args: [d.router, maxUint256] }));
      const params = { coin: address, amountIn: amounts[i]!, minAmountOut: expected.amountOut, recipient: zeroAddress, referrer: zeroAddress, deadline: BigInt((await chainNow()) + 3_600) };
      const value = quote === zeroAddress ? amounts[i]! : 0n;
      const simulation = await publicClient.simulateContract({ address: d.router, abi: memeFunRouterAbi, functionName: "buyFor", args: [params, quote], account: devAccount("erin"), value });
      expect(simulation.result).toBe(expected.amountOut);
      await send(await wallet("erin").writeContract({ address: d.router, abi: memeFunRouterAbi, functionName: "buyFor", args: [params, quote], value }));
    }
    await waitIndexed(await publicClient.getBlockNumber());
    coin = (await api(`/v1/coins/${address}`)).body.coin;
    expect(coin.volumeTotalUsd).toBeCloseTo((coin.markets as Json[]).reduce((sum, m) => sum + m.volumeTotalUsd, 0), 6);
    expect(coin.liquidityUsd).toBeCloseTo((coin.markets as Json[]).reduce((sum, m) => sum + m.liquidityUsd, 0), 6);
    for (const market of markets) {
      const trades = (await api(`/v1/coins/${address}/trades?poolId=${market.poolId}`)).body.trades as Json[];
      expect(trades).toHaveLength(2);
      expect(trades.every((t) => t.poolId === market.poolId && t.quote.toLowerCase() === market.quote.address.toLowerCase())).toBe(true);
    }
    const other = await coinBySymbol("FROG");
    expect((await api(`/v1/coins/${address}/pool?poolId=${other.markets[0].poolId}`)).status).toBe(404);

    await send(await creator.writeContract({ address: d.hook, abi: memeFunHookAbi, functionName: "lowerFee", args: [address, 50n] }));
    await send(await creator.writeContract({ address: d.hook, abi: memeFunHookAbi, functionName: "proposeCreator", args: [address, devAccount("bob").address] }));
    await waitIndexed(await publicClient.getBlockNumber());
    expect((await api(`/v1/coins/${address}`)).body.coin.pendingCreator).toBe(devAccount("bob").address);
    await send(await creator.writeContract({ address: d.hook, abi: memeFunHookAbi, functionName: "proposeCreator", args: [address, zeroAddress] }));
    await waitIndexed(await publicClient.getBlockNumber());
    expect((await api(`/v1/coins/${address}`)).body.coin.pendingCreator).toBeNull();
    await send(await creator.writeContract({ address: d.hook, abi: memeFunHookAbi, functionName: "proposeCreator", args: [address, devAccount("bob").address] }));
    await send(await wallet("bob").writeContract({ address: d.hook, abi: memeFunHookAbi, functionName: "acceptCreator", args: [address] }));
    await waitIndexed(await publicClient.getBlockNumber());
    coin = (await api(`/v1/coins/${address}`)).body.coin;
    expect(coin.creator).toBe(devAccount("bob").address);
    expect(coin.terms.feeBps).toBe(50);
    expect(coin.terms.mode).toBe("creator");
    const claimables = (await api(`/v1/claimables/${devAccount("bob").address}`)).body.claimables as Json[];
    expect(claimables.filter((c) => c.kind === "creator" && c.coin === address)).toHaveLength(3);
    const former = (await api(`/v1/claimables/${creator.account.address}`)).body.claimables as Json[];
    expect(former.some((c) => c.kind === "creator" && c.coin === address)).toBe(false);

    const pending = await Promise.all(quotes.map((quote) => publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "creatorPendingFor", args: [address, quote] })));
    expect(pending.every((amount) => amount > 0n)).toBe(true);
    const recipient = devAccount("alice").address;
    const before = await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    await send(await wallet("bob").writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "claimCreatorFor", args: [address, d.usdc, recipient] }));
    const after = await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    expect(after - before).toBe(pending[1]);
    expect(await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "creatorPendingFor", args: [address, zeroAddress] })).toBe(pending[0]);
    expect(await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "creatorPendingFor", args: [address, d.stock!] })).toBe(pending[2]);
    await waitIndexed(await publicClient.getBlockNumber());
    expect((await verifyIndex()).coins).toBe(8);
  });

  it("a tweet launch reserves both currencies and lets the verified author claim before treasury unlock", async () => {
    const launcher = wallet("dave");
    const salt = keccak256(toHex("e2e-tweet-author"));
    const address = await publicClient.readContract({ address: d.factory, abi: memeFunFactoryAbi, functionName: "predictCoin", args: [launcher.account.address, salt] });
    const deadline = BigInt((await chainNow()) + 3_600);
    const tweet = { postId: 2019264360682778716n, authorXUserId: 44196397n, authorShareBps: 5000 };
    const signature = await wallet("publisher").signTypedData({ domain: { name: "MemeFunFactory", version: "1", chainId: LOCAL_CHAIN_ID, verifyingContract: d.factory },
      types: TWEET_LAUNCH_TYPES, primaryType: "TweetLaunch", message: { launcher: launcher.account.address, salt, ...tweet, deadline } });
    await send(await launcher.writeContract({ address: d.usdc, abi: erc20Abi, functionName: "approve", args: [d.factory, 25_000_000n] }));
    const pairs = [{ quote: zeroAddress, firstBuyAmount: parseEther("0.01"), firstBuyMinCoins: 0n, expectedStartTick: 0, maxTickDrift: 0xffffff },
      { quote: d.usdc, firstBuyAmount: 25_000_000n, firstBuyMinCoins: 0n, expectedStartTick: 0, maxTickDrift: 0xffffff }];
    await send(await launcher.writeContract({ address: d.factory, abi: memeFunFactoryAbi, functionName: "launchTweetMulti",
      args: [{ name: "Tweet Cat", symbol: "XCAT", contractURI: "ipfs://e2e-tweet-cat", ...pairs[0]!, mode: 0, feeBps: 100, creatorKeepBps: 0, salt, deadline }, pairs, tweet, deadline, signature], value: pairs[0]!.firstBuyAmount }));
    await waitIndexed(await publicClient.getBlockNumber());
    const coin = (await api(`/v1/coins/${address}`)).body.coin;
    expect(coin.tweet).toMatchObject({ postId: tweet.postId.toString(), authorXUserId: tweet.authorXUserId.toString(), authorShareBps: 5000 });
    const pending = await Promise.all([zeroAddress, d.usdc].map(quote => publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [address, quote] })));
    expect(pending.every(amount => amount > 0n)).toBe(true);
    const reserved = await api(`/v1/coins/${address}/author`);
    expect(reserved.status).toBe(200);
    expect(reserved.body.status).toBe("unverified");
    expect(reserved.body.treasuryUnlocked).toBe(false);
    expect(reserved.body.treasuryUnlockAt).toBe(coin.tweet.treasuryUnlockAt);
    expect((await api(`/v1/claimables/${launcher.account.address}`)).body.claimables.some((c: Json) => c.kind === "author" && c.coin === address)).toBe(false);
    await expect(publicClient.simulateContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "claimAuthorFor", args: [address, d.usdc, launcher.account.address], account: launcher.account })).rejects.toThrow();
    await expect(publicClient.simulateContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "reclaimExpiredAuthorFor", args: [address, d.usdc], account: devAccount("treasury") })).rejects.toThrow();

    const author = wallet("alice");
    const authorSignature = await wallet("publisher").signTypedData({ domain: { name: "MemeFunFeeVault", version: "1", chainId: LOCAL_CHAIN_ID, verifyingContract: d.feeVault },
      types: AUTHOR_VERIFICATION_TYPES, primaryType: "AuthorVerification", message: { coin: address, authorXUserId: tweet.authorXUserId, wallet: author.account.address, deadline } });
    await send(await author.writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "verifyAuthor", args: [address, author.account.address, deadline, authorSignature] }));
    await waitIndexed(await publicClient.getBlockNumber());
    const claimables = (await api(`/v1/claimables/${author.account.address}`)).body.claimables.filter((c: Json) => c.kind === "author" && c.coin === address) as Json[];
    expect(claimables).toHaveLength(2);
    expect(new Set(claimables.map(c => c.currency.toLowerCase()))).toEqual(new Set([zeroAddress, d.usdc.toLowerCase()]));
    const balance = await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [author.account.address] });
    await send(await author.writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "claimAuthorFor", args: [address, d.usdc, author.account.address] }));
    expect(await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [author.account.address] })).toBe(balance + pending[1]!);
    expect(await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [address, zeroAddress] })).toBe(pending[0]);
    await waitIndexed(await publicClient.getBlockNumber());
    expect((await verifyIndex()).coins).toBe(9);
  });

  it("after180days authors can bind late and both author and treasury withdraw the same replenishing balance", async () => {
    const launcher = wallet("dave");
    const salt = keccak256(toHex("e2e-shared-tweet-author-balance"));
    const address = await publicClient.readContract({ address: d.factory, abi: memeFunFactoryAbi, functionName: "predictCoin", args: [launcher.account.address, salt] });
    const deadline = BigInt((await chainNow()) + 3_600);
    const tweet = { postId: 2019264360682778717n, authorXUserId: 44196398n, authorShareBps: 10000 };
    const signature = await wallet("publisher").signTypedData({ domain: { name: "MemeFunFactory", version: "1", chainId: LOCAL_CHAIN_ID, verifyingContract: d.factory },
      types: TWEET_LAUNCH_TYPES, primaryType: "TweetLaunch", message: { launcher: launcher.account.address, salt, ...tweet, deadline } });
    const pair = { quote: zeroAddress, firstBuyAmount: parseEther("0.01"), firstBuyMinCoins: 0n, expectedStartTick: 0, maxTickDrift: 0xffffff };
    await send(await launcher.writeContract({ address: d.factory, abi: memeFunFactoryAbi, functionName: "launchTweetMulti",
      args: [{ name: "Unverified Tweet", symbol: "XWAIT", contractURI: "ipfs://e2e-tweet-wait", ...pair, mode: 0, feeBps: 100, creatorKeepBps: 0, salt, deadline }, [pair], tweet, deadline, signature], value: pair.firstBuyAmount }));
    await waitIndexed(await publicClient.getBlockNumber());
    const attribution = await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "tweetAttribution", args: [address] });
    const reserved = await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [address, zeroAddress] });
    expect(reserved).toBeGreaterThan(0n);
    expect(await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "creatorPendingFor", args: [address, zeroAddress] })).toBe(0n);
    await expect(publicClient.simulateContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "reclaimExpiredAuthorFor", args: [address, zeroAddress], account: devAccount("treasury") })).rejects.toThrow();
    await warpTo(Number(attribution[3]));
    const treasury = wallet("treasury");
    await expect(publicClient.simulateContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "reclaimExpiredAuthorFor", args: [address, zeroAddress], account: devAccount("frank") })).rejects.toThrow();
    expect(await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [address, zeroAddress] })).toBe(reserved);

    // The previous coin is already verified and has paid its author in USDC. Its remaining ETH
    // balance becomes treasury-withdrawable too; verification and a prior claim give no exemption.
    const verified = await coinBySymbol("XCAT");
    const verifiedEth = await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [verified.address, zeroAddress] });
    expect(verifiedEth).toBeGreaterThan(0n);
    const treasuryBefore = await publicClient.getBalance({ address: treasury.account.address });
    const swept = await send(await treasury.writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "reclaimExpiredAuthorFor", args: [verified.address, zeroAddress] }));
    expect(await publicClient.getBalance({ address: treasury.account.address })).toBe(treasuryBefore + verifiedEth - swept.gasUsed * swept.effectiveGasPrice);
    await expect(publicClient.simulateContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "claimAuthorFor", args: [verified.address, zeroAddress, devAccount("alice").address], account: devAccount("alice") })).rejects.toThrow();

    // A different author binds after day180 and claims the original unpaid reserve before the
    // treasury withdraws it. The same pending balance, rather than an expiry bucket, is paid.
    const lateAuthor = wallet("bob");
    const lateDeadline = BigInt((await chainNow()) + 3_600);
    const lateSignature = await wallet("publisher").signTypedData({ domain: { name: "MemeFunFeeVault", version: "1", chainId: LOCAL_CHAIN_ID, verifyingContract: d.feeVault },
      types: AUTHOR_VERIFICATION_TYPES, primaryType: "AuthorVerification", message: { coin: address, authorXUserId: tweet.authorXUserId, wallet: lateAuthor.account.address, deadline: lateDeadline } });
    await send(await lateAuthor.writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "verifyAuthor", args: [address, lateAuthor.account.address, lateDeadline, lateSignature] }));
    const lateBefore = await publicClient.getBalance({ address: lateAuthor.account.address });
    const claimed = await send(await lateAuthor.writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "claimAuthorFor", args: [address, zeroAddress, lateAuthor.account.address] }));
    expect(await publicClient.getBalance({ address: lateAuthor.account.address })).toBe(lateBefore + reserved - claimed.gasUsed * claimed.effectiveGasPrice);
    await expect(publicClient.simulateContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "reclaimExpiredAuthorFor", args: [address, zeroAddress], account: treasury.account })).rejects.toThrow();

    const params = { coin: address, amountIn: parseEther("0.005"), minAmountOut: 0n, recipient: zeroAddress, referrer: zeroAddress, deadline: BigInt((await chainNow()) + 3_600) };
    const platformBefore = await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "platformPending", args: [zeroAddress] });
    const feeBefore = await publicClient.readContract({ address: d.poolManager, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [d.feeVault, 0n] });
    await send(await wallet("erin").writeContract({ address: d.router, abi: memeFunRouterAbi, functionName: "buyFor", args: [params, zeroAddress], value: params.amountIn }));
    const newReserve = await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [address, zeroAddress] });
    const feeAfter = await publicClient.readContract({ address: d.poolManager, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [d.feeVault, 0n] });
    const platformAfter = await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "platformPending", args: [zeroAddress] });
    expect(newReserve).toBeGreaterThan(0n);
    expect(platformAfter - platformBefore + newReserve).toBe(feeAfter - feeBefore); // No automatic author-to-platform redirect.
    const repeatBefore = await publicClient.getBalance({ address: treasury.account.address });
    const repeatSweep = await send(await treasury.writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "reclaimExpiredAuthorFor", args: [address, zeroAddress] }));
    expect(await publicClient.getBalance({ address: treasury.account.address })).toBe(repeatBefore + newReserve - repeatSweep.gasUsed * repeatSweep.effectiveGasPrice);
    expect(await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [address, zeroAddress] })).toBe(0n);

    // A treasury withdrawal does not forfeit future author fees. Test ERC20 accounting as well:
    // first the treasury takes new USDC, then the author claims fees from a later trade.
    const buyer = wallet("erin");
    await send(await buyer.writeContract({ address: d.usdc, abi: erc20Abi, functionName: "approve", args: [d.router, maxUint256] }));
    const usdcBuy = { ...params, coin: verified.address, amountIn: 5_000_000n };
    await send(await buyer.writeContract({ address: d.router, abi: memeFunRouterAbi, functionName: "buyFor", args: [usdcBuy, d.usdc] }));
    const usdcReserve = await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [verified.address, d.usdc] });
    expect(usdcReserve).toBeGreaterThan(0n);
    const treasuryUsdc = await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [treasury.account.address] });
    await send(await treasury.writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "reclaimExpiredAuthorFor", args: [verified.address, d.usdc] }));
    expect(await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [treasury.account.address] })).toBe(treasuryUsdc + usdcReserve);
    await send(await buyer.writeContract({ address: d.router, abi: memeFunRouterAbi, functionName: "buyFor", args: [{ ...usdcBuy, amountIn: 2_000_000n }, d.usdc] }));
    const later = await publicClient.readContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "authorPendingFor", args: [verified.address, d.usdc] });
    expect(later).toBeGreaterThan(0n);
    const alice = wallet("alice");
    const authorUsdc = await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [alice.account.address] });
    await waitIndexed(await publicClient.getBlockNumber());
    expect((await api(`/v1/claimables/${alice.account.address}`)).body.claimables.some((c: Json) => c.kind === "author" && c.coin === verified.address && BigInt(c.amountRaw) === later)).toBe(true);
    await send(await alice.writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "claimAuthorFor", args: [verified.address, d.usdc, alice.account.address] }));
    expect(await publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [alice.account.address] })).toBe(authorUsdc + later);
    await waitIndexed(await publicClient.getBlockNumber());
    expect((await api(`/v1/coins/${address}/author`)).body).toMatchObject({ status: "verified", treasuryUnlocked: true, verifiedWallet: lateAuthor.account.address });
    expect((await api(`/v1/coins/${verified.address}`)).body.coin.tweet).toMatchObject({ treasuryUnlocked: true, reclaimed: true, authorWallet: alice.account.address });
    expect((await verifyIndex()).coins).toBe(10);
  });
});

