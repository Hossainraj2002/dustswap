/**
 * Seeds the local chain with a small, realistic memefun market so the indexer, API and UI have
 * something true to show. Everything goes through the real contracts with anvil's dev accounts:
 *
 *   - six coins: all four fee modes and all three pair kinds (ETH, USDC, tokenized stock), with
 *     metadata and images in the local media store (`ipfs://<cid>` contractURIs)
 *   - two buys in the SAME block inside launch protection (snipers), then about two hours of
 *     trading (buys, partial sells, referred trades), chain time moved forward between rounds
 *   - a buyback and burn, a floor add, a creator claim, a referral claim, a fee cut, and a
 *     price-keeper update of the stock's NAV
 *
 *   pnpm dev:seed            (pnpm dev:chain runs it automatically)
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  type Address,
  type Hash,
  erc20Abi,
  keccak256,
  maxUint256,
  parseEther,
  parseUnits,
  toHex,
  zeroAddress,
} from "viem";

import { loadDeployment } from "../lib/deployment";
import { type DevRole, devAccount, localClients } from "../lib/dev";
import { processCoinImage } from "../lib/media/image";
import { LocalMediaStore } from "../lib/media/local";
import { buildMetadata, encodeMetadata } from "../lib/media/metadata";
import { LOCAL_CHAIN_ID } from "../lib/chain";
import { loadLocalEnv, optionalEnv } from "../lib/env";
import {
  buybackBurnVaultAbi,
  feeVaultAbi,
  floorVaultAbi,
  memeFunConfigAbi,
  memeFunFactoryAbi,
  memeFunHookAbi,
  memeFunRouterAbi,
} from "../shared/abis";

const MODE = { creator: 0, burn: 1, holders: 2, floor: 3 } as const;

interface SeedCoin {
  name: string;
  symbol: string;
  description: string;
  creator: DevRole;
  quote: "eth" | "usdc" | "stock";
  mode: keyof typeof MODE;
  feeBps: number;
  keepBps: number;
  /** In the pair asset's units. */
  firstBuy: bigint;
  hue: number;
  links: { x?: string; telegram?: string; website?: string };
}

const COINS: SeedCoin[] = [
  { name: "Based Frog", symbol: "FROG", description: "The frog that only lives on Base.", creator: "alice", quote: "eth", mode: "creator", feeBps: 100, keepBps: 0, firstBuy: parseEther("0.05"), hue: 140, links: { x: "frogonbase", website: "https://frog.example" } },
  { name: "Burn Cat", symbol: "BCAT", description: "Every fee buys BCAT back and burns it.", creator: "bob", quote: "eth", mode: "burn", feeBps: 300, keepBps: 1_000, firstBuy: parseEther("0.02"), hue: 18, links: { telegram: "burncat_chat" } },
  { name: "Holder Dog", symbol: "HDOG", description: "Fees go to holders, twice a day.", creator: "alice", quote: "usdc", mode: "holders", feeBps: 200, keepBps: 0, firstBuy: parseUnits("100", 6), hue: 205, links: { x: "holderdog" } },
  { name: "Floor Ape", symbol: "FAPE", description: "Fees build a floor under the price.", creator: "bob", quote: "stock", mode: "floor", feeBps: 500, keepBps: 2_500, firstBuy: parseUnits("1", 8), hue: 270, links: {} },
  { name: "Stock Pup", symbol: "SPUP", description: "Paired with a tokenized stock.", creator: "carol", quote: "stock", mode: "creator", feeBps: 150, keepBps: 0, firstBuy: 0n, hue: 320, links: {} },
  { name: "Sleepy Moth", symbol: "MOTH", description: "Launched, then went to sleep.", creator: "dave", quote: "usdc", mode: "creator", feeBps: 100, keepBps: 0, firstBuy: 0n, hue: 48, links: {} },
];

/** Deterministic randomness, so every seeded chain is the same chain. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function coinSvg(coin: SeedCoin): string {
  const initials = coin.symbol.slice(0, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${coin.hue},80%,62%)"/><stop offset="1" stop-color="hsl(${(coin.hue + 40) % 360},75%,42%)"/>
  </linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <circle cx="256" cy="230" r="150" fill="rgba(255,255,255,0.18)"/>
  <text x="256" y="300" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="180" font-weight="700" fill="#ffffff">${initials}</text>
</svg>`;
}

export async function seed(options: { rpcUrl?: string } = {}) {
  const d = loadDeployment(LOCAL_CHAIN_ID);
  if (!d.stock) throw new Error("The local deployment has no mock stock; redeploy with DevDeploy.s.sol.");
  const { publicClient, testClient, wallet } = localClients(options.rpcUrl ?? optionalEnv("MEMEFUN_RPC_URLS")?.split(",")[0]);
  const store = new LocalMediaStore(
    resolve(optionalEnv("MEDIA_LOCAL_DIR") ?? "data/media"),
    optionalEnv("PUBLIC_API_URL") ?? "http://localhost:42069",
  );
  const random = rng(20261002);
  const quoteOf = { eth: zeroAddress, usdc: d.usdc, stock: d.stock } as const;

  const wait = async (hash: Hash) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return receipt;
  };
  const chainNow = async () => (await publicClient.getBlock()).timestamp;
  const advance = async (seconds: number) => {
    await testClient.increaseTime({ seconds });
    await testClient.mine({ blocks: 1 });
  };

  const approved = new Set<string>();
  const approve = async (role: DevRole, token: Address, spender: Address) => {
    const key = `${role}:${token}:${spender}`;
    if (approved.has(key)) return;
    await wait(await wallet(role).writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }));
    approved.add(key);
  };

  // ------------------------------------------------------------- trade helpers
  const coins = new Map<string, Address>();
  const router = d.router;
  const tradeParams = async (coin: Address, amountIn: bigint, referrer: Address = zeroAddress) => ({
    coin,
    amountIn,
    minAmountOut: 0n,
    recipient: zeroAddress,
    referrer,
    deadline: (await chainNow()) + 3_600n,
  });

  const buy = async (role: DevRole, symbol: string, amount: bigint, referrer?: DevRole, gas?: bigint) => {
    const spec = COINS.find((c) => c.symbol === symbol)!;
    const quote = quoteOf[spec.quote];
    if (quote !== zeroAddress) await approve(role, quote, router);
    return wallet(role).writeContract({
      address: router,
      abi: memeFunRouterAbi,
      functionName: "buy",
      args: [await tradeParams(coins.get(symbol)!, amount, referrer ? devAccount(referrer).address : zeroAddress)],
      value: quote === zeroAddress ? amount : 0n,
      ...(gas ? { gas } : {}),
    });
  };

  const sell = async (role: DevRole, symbol: string, fraction: number, referrer?: DevRole) => {
    const coin = coins.get(symbol)!;
    const balance = await publicClient.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [devAccount(role).address] });
    const amount = (balance * BigInt(Math.round(fraction * 10_000))) / 10_000n;
    if (amount === 0n) return;
    await approve(role, coin, router);
    await wait(
      await wallet(role).writeContract({
        address: router,
        abi: memeFunRouterAbi,
        functionName: "sell",
        args: [await tradeParams(coin, amount, referrer ? devAccount(referrer).address : zeroAddress)],
      }),
    );
  };

  // Two snipers buy FROG in the same block, right after its launch, while protection is on.
  const snipeFrog = async () => {
    await testClient.setAutomine(false);
    const sniped = [await buy("erin", "FROG", parseEther("0.03"), undefined, 900_000n), await buy("carol", "FROG", parseEther("0.02"), undefined, 900_000n)];
    await testClient.mine({ blocks: 1 });
    await testClient.setAutomine(true);
    for (const hash of sniped) await wait(hash);
    console.log("two same-block sniper buys on FROG");
    await advance(60);
  };

  // ---------------------------------------------------------------- launches
  for (const coin of COINS) {
    const png = await sharp(Buffer.from(coinSvg(coin))).png().toBuffer();
    const image = await store.put((await processCoinImage(new Uint8Array(png))).webp, "image/webp");
    const built = buildMetadata({ name: coin.name, symbol: coin.symbol, description: coin.description, image: image.uri, ...coin.links });
    if (!built.ok) throw new Error(`seed metadata for ${coin.symbol}: ${JSON.stringify(built.errors)}`);
    const metadata = await store.put(encodeMetadata(built.metadata), "application/json");

    const creator = wallet(coin.creator);
    const salt = keccak256(toHex(`memefun-seed-${coin.symbol}`));
    const address = await publicClient.readContract({
      address: d.factory,
      abi: memeFunFactoryAbi,
      functionName: "predictCoin",
      args: [creator.account.address, salt],
    });
    const quote = quoteOf[coin.quote];
    if (quote !== zeroAddress && coin.firstBuy > 0n) await approve(coin.creator, quote, d.factory);
    await wait(
      await creator.writeContract({
        address: d.factory,
        abi: memeFunFactoryAbi,
        functionName: "launch",
        args: [
          {
            name: coin.name,
            symbol: coin.symbol,
            contractURI: metadata.uri,
            quote,
            mode: MODE[coin.mode],
            feeBps: coin.feeBps,
            creatorKeepBps: coin.keepBps,
            salt,
            firstBuyAmount: coin.firstBuy,
            firstBuyMinCoins: 0n,
            expectedStartTick: 0,
            maxTickDrift: 0xffffff,
            deadline: (await chainNow()) + 3_600n,
          },
        ],
        value: quote === zeroAddress ? coin.firstBuy : 0n,
      }),
    );
    coins.set(coin.symbol, address);
    if (coin.symbol === "FROG") await snipeFrog();
    console.log(`launched ${coin.symbol.padEnd(5)} ${address} (${coin.mode}, ${coin.quote}, ${coin.feeBps / 100}%)`);
  }

  // ------------------------------------------------------------------ trading
  const traders: DevRole[] = ["carol", "dave", "erin", "frank"];
  const sizes = {
    eth: () => parseEther((0.004 + random() * 0.12).toFixed(6)),
    usdc: () => parseUnits((8 + random() * 300).toFixed(2), 6),
    stock: () => parseUnits((0.05 + random() * 1.5).toFixed(4), 8),
  };
  const active = ["FROG", "BCAT", "HDOG", "FAPE", "SPUP"];

  for (let round = 0; round < 8; round += 1) {
    for (const symbol of active) {
      const spec = COINS.find((c) => c.symbol === symbol)!;
      const trades = 1 + Math.floor(random() * 3);
      for (let t = 0; t < trades; t += 1) {
        const trader = traders[Math.floor(random() * traders.length)]!;
        const referrer: DevRole | undefined = trader !== "frank" && random() < 0.35 ? "frank" : undefined;
        if (random() < 0.7) await wait(await buy(trader, symbol, sizes[spec.quote](), referrer));
        else await sell(trader, symbol, 0.2 + random() * 0.5, referrer);
      }
    }
    if (round === 3) {
      const buyback = await wallet("deployer").writeContract({ address: d.buybackBurnVault, abi: buybackBurnVaultAbi, functionName: "executeBuyback", args: [coins.get("BCAT")!] });
      await wait(buyback);
      const floor = await wallet("deployer").writeContract({ address: d.floorVault, abi: floorVaultAbi, functionName: "addFloor", args: [coins.get("FAPE")!] });
      await wait(floor);
      console.log("buyback on BCAT and floor add on FAPE");
    }
    if (round === 5) {
      await wait(await wallet("alice").writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "claimCreator", args: [coins.get("FROG")!, devAccount("alice").address] }));
      await wait(await wallet("frank").writeContract({ address: d.feeVault, abi: feeVaultAbi, functionName: "claimReferral", args: [zeroAddress, devAccount("frank").address] }));
      await wait(await wallet("alice").writeContract({ address: d.hook, abi: memeFunHookAbi, functionName: "lowerFee", args: [coins.get("FROG")!, 80n] }));
      const stockPrice = await publicClient.readContract({ address: d.config, abi: memeFunConfigAbi, functionName: "quotePriceUsdE8", args: [d.stock] });
      await wait(await wallet("priceKeeper").writeContract({ address: d.config, abi: memeFunConfigAbi, functionName: "setManualPrice", args: [d.stock, (stockPrice * 10_120n) / 10_000n] }));
      console.log("creator claim, referral claim, FROG fee 1% -> 0.8%, stock NAV +1.2%");
    }
    await advance(15 * 60);
  }

  const block = await publicClient.getBlock();
  console.log(`seeded: ${COINS.length} coins, chain at block ${block.number}, time ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  seed().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
