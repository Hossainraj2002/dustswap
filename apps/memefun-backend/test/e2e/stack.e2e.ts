import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import pg from "pg";
import sharp from "sharp";
import { erc20Abi, getAddress, keccak256, parseEther, toHex, zeroAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createKeeperContext, type KeeperContext } from "../../keeper/context";
import { runEpochs } from "../../keeper/jobs/epochs";
import { runMetadata } from "../../keeper/jobs/metadata";
import { runBuybacks } from "../../keeper/jobs/modules";
import { LOCAL_CHAIN_ID } from "../../lib/chain";
import { loadDeployment } from "../../lib/deployment";
import { devAccount, localClients } from "../../lib/dev";
import { priceUsdE18 } from "../../lib/market/math";
import { EPOCH_LENGTH_SEC, latestBoundary } from "../../lib/rewards/twab";
import { verifyIndexAgainstChain } from "../../lib/verify/chain-truth";
import { COIN_SUPPLY } from "../../shared/core/constants";
import { holderRewardDistributorAbi, memeFunFactoryAbi, memeFunRouterAbi } from "../../shared/abis";

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
        functionName: "claim",
        args: [{ epoch: 1n, coin: getAddress(reward.coin), index: BigInt(reward.index), account: holder, amount: BigInt(reward.amountRaw), proof: reward.proof }],
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
});

