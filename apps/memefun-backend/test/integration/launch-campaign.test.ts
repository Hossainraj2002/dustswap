import { randomBytes } from "node:crypto";
import pg from "pg";
import { type Address, getAddress } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCampaignStore } from "../../lib/launch-campaign/store";
import { migrate } from "../../lib/migrate";

// Cannot accept DATABASE_URL, remote hosts, or private credentials. Only public local test access.
const port = Number(process.env.MEMEFUN_CAMPAIGN_TEST_PORT ?? "54339");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("MEMEFUN_CAMPAIGN_TEST_PORT must be a local test port");
const database = `memefun_campaign_test_${randomBytes(8).toString("hex")}`;
const ownedName = /^memefun_campaign_test_[a-f0-9]{16}$/;
const connection = { host: "127.0.0.1", port, user: "memefun", password: "memefun", connectionTimeoutMillis: 5000 };
const admin = new pg.Pool({ ...connection, database: "postgres", max: 1 });
let first: pg.Pool;
let second: pg.Pool;
let created = false;
const address = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const WALLET = address(1), OTHER = address(2), MODULE = address(3), ROUTER = address(4);

function assertOwned() { if (!created || !ownedName.test(database)) throw new Error("refusing to mutate a database not created by this test run"); }
beforeAll(async () => {
  if (!ownedName.test(database)) throw new Error("invalid local test database name");
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  first = new pg.Pool({ ...connection, database, max: 8, options: "-c search_path=memefun_app,public -c statement_timeout=15000" });
  second = new pg.Pool({ ...connection, database, max: 8, options: "-c search_path=memefun_app,public -c statement_timeout=15000" });
  await migrate(first);
  // Minimal indexed table fixtures use the production columns/types consumed by the real SQL.
  await first.query(`CREATE TABLE public.coin (address text PRIMARY KEY, launcher text NOT NULL, creator text NOT NULL, launched boolean NOT NULL);
    CREATE TABLE public.activity (id text PRIMARY KEY, kind text NOT NULL, coin text NOT NULL, block_number numeric NOT NULL, log_index integer NOT NULL);
    CREATE TABLE public.trade (id text PRIMARY KEY, coin text NOT NULL, trader text NOT NULL, sender text NOT NULL, kind text NOT NULL,
      quote_amount numeric NOT NULL, coin_amount numeric NOT NULL, block_number numeric NOT NULL, log_index integer NOT NULL);
    CREATE TABLE public.market (pool_id text PRIMARY KEY, coin text NOT NULL);
    CREATE TABLE public._ponder_checkpoint (chain_id integer PRIMARY KEY, latest_checkpoint varchar(75) NOT NULL,
      safe_checkpoint varchar(75) NOT NULL, finalized_checkpoint varchar(75) NOT NULL)`);
});
beforeEach(async () => {
  assertOwned();
  await first.query("TRUNCATE public.coin, public.activity, public.trade, public.market, public._ponder_checkpoint, memefun_app.launch_campaign_quota, memefun_app.moderation");
});
afterAll(async () => {
  await Promise.allSettled([first?.end(), second?.end()]);
  try {
    if (created) { assertOwned(); await admin.query(`DROP DATABASE "${database}"`); created = false; }
  } finally { await admin.end(); }
});

async function launch(coin: Address, wallet: Address, block: number, log: number, options: { launched?: boolean; kind?: string } = {}) {
  await first.query("INSERT INTO public.coin(address,launcher,creator,launched) VALUES($1,$2,$2,$3)", [coin.toLowerCase(), wallet.toLowerCase(), options.launched ?? true]);
  await first.query("INSERT INTO public.activity(id,kind,coin,block_number,log_index) VALUES($1,$2,$1,$3,$4)", [coin.toLowerCase(), options.kind ?? "launch", block, log]);
}
async function trade(id: string, block: number, options: { wallet?: Address; sender?: Address; coin?: Address; kind?: string; quote?: number; amount?: number } = {}) {
  await first.query("INSERT INTO public.trade VALUES($1,$2,$3,$4,$5,$6,$7,$8,0)",
    [id, (options.coin ?? address(100)).toLowerCase(), (options.wallet ?? WALLET).toLowerCase(), (options.sender ?? ROUTER).toLowerCase(),
      options.kind ?? "trade", options.quote ?? 100, options.amount ?? 10, block]);
}

describe("canonical campaign SQL and replica quotas in real Postgres", () => {
  it("ranks first unique immutable launchers strictly after activation through finality, using block/log order", async () => {
    await launch(address(100), WALLET, 101, 5);
    await launch(address(101), OTHER, 101, 4); // earlier log, despite later insertion and coin address
    await launch(address(102), WALLET, 102, 0); // second launch consumes no new slot
    await launch(address(103), address(5), 100, 100); // activation block is excluded
    await launch(address(104), address(6), 99, 0); // historical
    await launch(address(105), address(7), 111, 0); // not finalized
    await launch(address(106), address(8), 103, 0, { launched: false });
    await launch(address(107), address(9), 103, 1, { kind: "trade" });
    const store = createCampaignStore(first, first, [MODULE]);
    expect(await store.launches(100n, 110n)).toEqual([
      { wallet: OTHER, coin: address(101), slot: 0, launchBlock: 101n },
      { wallet: WALLET, coin: address(100), slot: 1, launchBlock: 101n },
    ]);
    expect(await store.hasLaunch(address(5), 100n, 99n)).toBe(false);
    expect(await store.hasLaunch(address(7), 100n, 110n)).toBe(true);
  });
  it("preserves slots across creator transfer, hidden moderation, multi-pair coins and independent replicas", async () => {
    await launch(address(100), WALLET, 101, 0);
    await launch(address(101), OTHER, 102, 0);
    await first.query("INSERT INTO public.market VALUES ('eth', $1), ('usdc', $1)", [address(100).toLowerCase()]);
    const a = createCampaignStore(first, first, [MODULE]), b = createCampaignStore(second, second, [MODULE]);
    const before = await a.launches(100n, 110n);
    await first.query("UPDATE public.coin SET creator=$1 WHERE address=$2", [OTHER.toLowerCase(), address(100).toLowerCase()]);
    await first.query("INSERT INTO memefun_app.moderation (coin, hidden) VALUES ($1,true)", [address(100).toLowerCase()]);
    expect(await b.launches(100n, 110n)).toEqual(before);
    expect(await a.launches(100n, 110n)).toHaveLength(2);
  });
  it("assigns exactly slots 0..999 and leaves the 1001st launcher outside the campaign", async () => {
    await first.query(`INSERT INTO public.coin SELECT '0x' || lpad(to_hex(n+10000),40,'0'), '0x' || lpad(to_hex(n+20000),40,'0'),
      '0x' || lpad(to_hex(n+20000),40,'0'), true FROM generate_series(1,1001) n`);
    await first.query(`INSERT INTO public.activity SELECT address, 'launch', address, 100 + ROW_NUMBER() OVER (ORDER BY address), 0 FROM public.coin`);
    const rows = await createCampaignStore(first, first, [MODULE]).launches(100n, 2000n);
    expect(rows).toHaveLength(1000);
    expect(rows[0]!.slot).toBe(0); expect(rows[999]!.slot).toBe(999);
    expect(rows.some(row => row.wallet.toLowerCase() === address(21001).toLowerCase())).toBe(false);
    // Repeated and concurrent reads do not allocate another slot or depend on request order.
    expect(await createCampaignStore(second, second, [MODULE]).launches(100n, 2000n)).toEqual(rows);
  });
  it("requires a positive later-block regular trade by the launcher, excludes first buys/modules, and permits another MemeFun token", async () => {
    await launch(address(100), WALLET, 101, 0);
    await launch(address(101), OTHER, 99, 0);
    await launch(address(102), OTHER, 99, 1, { launched: false });
    const store = createCampaignStore(first, first, [MODULE]);
    await trade("same-block", 101);
    await trade("first-buy", 102, { kind: "first_buy" });
    await trade("buyback", 103, { kind: "buyback" });
    await trade("module", 104, { sender: MODULE });
    await trade("wrong-wallet", 105, { wallet: OTHER });
    await trade("zero-quote", 106, { quote: 0 });
    await trade("zero-coins", 107, { amount: 0 });
    await trade("unlaunched", 108, { coin: address(102) });
    await trade("unfinalized", 111);
    expect(await store.tradeBlock(WALLET, 101n, 110n)).toBeNull();
    await trade("valid-other-token", 109, { coin: address(101) });
    expect(await store.tradeBlock(WALLET, 101n, 110n)).toBe(109n);
  });
  it("uses canonical checkpoint readiness even when the finalized block contains no application events", async () => {
    const cp = (block: number, tail: string) => `1780000000${String(8453).padStart(16,"0")}${String(block).padStart(16,"0")}${tail}`;
    const store = createCampaignStore(first, first, [MODULE]);
    await first.query("INSERT INTO public._ponder_checkpoint VALUES(8453,$1,$1,$1)", [cp(110, "0".repeat(33))]);
    expect(await store.caughtUp(8453, 110n)).toBe(false);
    await first.query("UPDATE public._ponder_checkpoint SET latest_checkpoint=$1,safe_checkpoint=$1,finalized_checkpoint=$1", [cp(111, "0".repeat(33))]);
    expect(await store.caughtUp(8453, 110n)).toBe(true);
    expect(await store.launches(100n, 110n)).toEqual([]);
    // Actual multichain Ponder updates safe_checkpoint from pruned user events only. A quiet
    // finalized interval has durable complete history despite an older event watermark.
    await first.query("UPDATE public._ponder_checkpoint SET safe_checkpoint=$1", [cp(109, "9".repeat(33))]);
    expect(await store.caughtUp(8453, 110n)).toBe(true);
    // A restart can retain an optimistic latest checkpoint above durable indexed rows.
    await first.query("UPDATE public._ponder_checkpoint SET finalized_checkpoint=$1", [cp(109, "9".repeat(33))]);
    expect(await store.caughtUp(8453, 110n)).toBe(false);
  });
  it("admits only the limit across simultaneous replicas and budgets expire into a new window", async () => {
    const a = createCampaignStore(first, first, []), b = createCampaignStore(second, second, []);
    const results = await Promise.all(Array.from({ length: 50 }, (_, n) => (n % 2 ? a : b).quota("ticket:wallet:race", 7, 60, 120)));
    expect(results.filter(Boolean)).toHaveLength(7);
    expect(await a.quota("ticket:wallet:race", 7, 60, 179)).toBe(false);
    expect(await b.quota("ticket:wallet:race", 7, 60, 180)).toBe(true);
    expect(await a.quota("ticket:wallet:other", 7, 60, 120)).toBe(true);
    expect((await first.query("SELECT count FROM launch_campaign_quota WHERE key=$1 AND window_start=120", ["ticket:wallet:race"])).rows[0].count).toBe(8);
  });
  it("migrates once across replicas and prunes expired campaign quotas only", async () => {
    expect(await migrate(second)).toEqual([]);
    const store = createCampaignStore(first, first, []);
    await store.quota("expired", 3, 60, 1);
    await store.quota("current", 3, 60);
    await store.prune();
    expect((await first.query("SELECT key FROM launch_campaign_quota")).rows).toEqual([{ key: "current" }]);
  });
});
