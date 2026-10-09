import { randomBytes } from "node:crypto";
import pg from "pg";
import { type Address, type Hex, getAddress } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../lib/migrate";
import { type PlatformLaunch, createPlatformTokenStore } from "../../lib/platform-token/store";

// Never read DATABASE_URL, operator env files, remote hosts, or private credentials.
const port = Number(process.env.MEMEFUN_PLATFORM_TOKEN_TEST_PORT ?? "54339");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local platform-token test port");
const database = `memefun_platform_test_${randomBytes(8).toString("hex")}`;
const ownedName = /^memefun_platform_test_[a-f0-9]{16}$/;
const connection = { host: "127.0.0.1", port, user: "memefun", password: "memefun", connectionTimeoutMillis: 5_000 };
const admin = new pg.Pool({ ...connection, database: "postgres", max: 1 });
let a: pg.Pool, b: pg.Pool;
let created = false;
const address = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const WALLET = address(1), FACTORY = address(2), OTHER = address(3);
const scope = { chainId: 8453, factory: FACTORY };
const salt = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const blockHash = salt(10_000);

function assertOwned() { if (!created || !ownedName.test(database)) throw new Error("Refusing to mutate an unowned test database"); }
beforeAll(async () => {
  if (!ownedName.test(database)) throw new Error("Invalid test database name");
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  a = new pg.Pool({ ...connection, database, max: 8, options: "-c search_path=memefun_app,public -c statement_timeout=15000" });
  b = new pg.Pool({ ...connection, database, max: 8, options: "-c search_path=memefun_app,public -c statement_timeout=15000" });
  await migrate(a);
  await a.query(`CREATE TABLE public.coin (address text PRIMARY KEY, launcher text NOT NULL, creator text NOT NULL,
      contract_uri text NOT NULL, launch_tx text NOT NULL, launched boolean NOT NULL);
    CREATE TABLE public.activity (id text PRIMARY KEY, kind text NOT NULL, coin text NOT NULL, block_number numeric NOT NULL,
      log_index integer NOT NULL, timestamp integer NOT NULL, tx_hash text NOT NULL);
    CREATE TABLE public._ponder_checkpoint (chain_id integer PRIMARY KEY, latest_checkpoint varchar(75) NOT NULL)`);
});
beforeEach(async () => {
  assertOwned();
  await a.query("TRUNCATE public.coin, public.activity, public._ponder_checkpoint, memefun_app.platform_token_pin, memefun_app.platform_token_intent, memefun_app.platform_token_quota");
});
afterAll(async () => {
  await Promise.allSettled([a?.end(), b?.end()]);
  try { if (created) { assertOwned(); await admin.query(`DROP DATABASE "${database}"`); created = false; } }
  finally { await admin.end(); }
});

async function prepare(n: number, options: { factory?: Address; uri?: string; launcher?: Address; afterBlock?: bigint } = {}) {
  const coin = address(100 + n), contractURI = options.uri ?? `ipfs://official-${n}`;
  const result = await createPlatformTokenStore(a, a).prepare({ ...scope, factory: options.factory ?? FACTORY }, {
    coin, launcher: options.launcher ?? WALLET, salt: salt(n), contractURI, afterBlock: options.afterBlock ?? 99n,
  });
  if (result.state !== "created" && result.state !== "existing") throw new Error("Unexpected intent state");
  return result.intent;
}
async function launched(n: number, block: number, log: number, options: { wallet?: Address; uri?: string; timestamp?: number; kind?: string; tx?: Hex; launched?: boolean } = {}): Promise<PlatformLaunch> {
  const coin = address(100 + n), launcher = options.wallet ?? WALLET, contractURI = options.uri ?? `ipfs://official-${n}`, txHash = options.tx ?? salt(n + 1000);
  await a.query("INSERT INTO public.coin VALUES ($1,$2,$3,$4,$5,$6)", [coin.toLowerCase(), launcher.toLowerCase(), OTHER.toLowerCase(), contractURI, txHash, options.launched ?? true]);
  await a.query("INSERT INTO public.activity VALUES ($1,$2,$1,$3,$4,$5,$6)", [coin.toLowerCase(), options.kind ?? "launch", block, log, options.timestamp ?? Math.floor(Date.now() / 1000) + 1, txHash]);
  return { coin, launcher, contractURI, launchBlock: BigInt(block), logIndex: log, txHash };
}

describe("durable official launch selection in real Postgres", () => {
  it("preserves exactly one idempotent intent across simultaneous replicas and rejects changed binding", async () => {
    const one = createPlatformTokenStore(a, a), two = createPlatformTokenStore(b, b);
    const input = { coin: address(101), launcher: WALLET, salt: salt(1), contractURI: "ipfs://official-1", afterBlock: 99n };
    const values = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? one : two).prepare(scope, input)));
    expect(values.filter(v => v.state === "created")).toHaveLength(1);
    expect(values.filter(v => v.state === "existing")).toHaveLength(11);
    const records = values.flatMap(v => "intent" in v ? [v.intent] : []);
    expect(new Set(records.map(v => v.createdAt)).size).toBe(1);
    expect(await two.prepare(scope, { ...input, contractURI: "ipfs://changed" })).toEqual({ state: "conflict" });
    expect((await a.query("SELECT count(*) FROM memefun_app.platform_token_intent")).rows[0].count).toBe("1");
  });
  it("does not consume the official slot for unlaunched/canceled preparations and uses real block/log order", async () => {
    await prepare(1); await prepare(2); await prepare(3); // canceled 1, request order 2 before 3
    await launched(2, 102, 0); const earlier = await launched(3, 101, 20);
    expect(await createPlatformTokenStore(a, a).candidate(scope, 102n, WALLET)).toEqual(earlier);
    expect(await createPlatformTokenStore(b, b).pin(scope)).toBeNull();
  });
  it("uses exact original launcher/URI and excludes historical, incomplete, nonlaunch and wrong-factory data", async () => {
    await prepare(1); await launched(1, 99, 0); // same observed block cannot be a fresh creation
    await prepare(2); await launched(2, 100, 0, { wallet: OTHER });
    await prepare(3); await launched(3, 100, 1, { uri: "ipfs://changed" });
    await prepare(4); await launched(4, 100, 2, { kind: "trade" });
    await prepare(5); await launched(5, 100, 3, { launched: false });
    await prepare(6, { factory: OTHER }); await launched(6, 100, 4);
    await prepare(7); await launched(7, 100, 5, { timestamp: 1 });
    await prepare(8); await launched(8, 105, 0); // outside confirmed boundary
    expect(await createPlatformTokenStore(a, a).candidate(scope, 104n, WALLET)).toBeNull();
    const valid = await prepare(9); const found = await launched(9, 104, 9);
    expect(await createPlatformTokenStore(a, a).candidate(scope, 104n, WALLET)).toEqual(found);
    expect(found.coin).toBe(valid.coin);
  });
  it("does not allow mutable current creator or moderation to change official identity", async () => {
    await prepare(1); const launch = await launched(1, 101, 0);
    await a.query("INSERT INTO memefun_app.moderation (coin,hidden) VALUES ($1,true)", [launch.coin.toLowerCase()]);
    expect(await createPlatformTokenStore(a, a).candidate(scope, 101n, WALLET)).toEqual(launch);
    await a.query("UPDATE public.coin SET creator=$1", [FACTORY.toLowerCase()]);
    expect(await createPlatformTokenStore(b, b).candidate(scope, 101n, WALLET)).toEqual(launch);
  });
  it("filters the configured launcher before chronological selection when configuration changes before pinning", async () => {
    await prepare(1); await launched(1, 100, 0);
    await prepare(2, { launcher: OTHER }); const current = await launched(2, 101, 0, { wallet: OTHER });
    expect(await createPlatformTokenStore(a, a).candidate(scope, 101n, OTHER)).toEqual(current);
  });
  it("atomically pins once under competing replica confirmations and never overwrites the winning coin", async () => {
    await prepare(1); await prepare(2);
    const first = { ...await launched(1, 101, 0), blockHash }, second = { ...await launched(2, 102, 0), blockHash: salt(10_001) };
    const one = createPlatformTokenStore(a, a), two = createPlatformTokenStore(b, b);
    const outcomes = await Promise.all([one.register(scope, first), two.register(scope, second)]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    const winner = outcomes[0]!;
    expect(await one.register(scope, winner.coin === first.coin ? second : first)).toEqual(winner);
    expect(await two.pin(scope)).toEqual(winner);
    expect((await a.query("SELECT count(*) FROM memefun_app.platform_token_pin")).rows[0].count).toBe("1");
    expect(await one.prepare(scope, { coin: address(103), launcher: WALLET, salt: salt(3), contractURI: "ipfs://official-3", afterBlock: 103n })).toEqual({ state: "pinned" });
  });
  it("keeps a pin after indexed history disappears, preventing reassignment after rollback", async () => {
    await prepare(1); const pin = { ...await launched(1, 101, 0), blockHash };
    const store = createPlatformTokenStore(a, a); await store.register(scope, pin);
    await a.query("DELETE FROM public.activity"); await a.query("DELETE FROM public.coin");
    expect(await store.pin(scope)).toEqual(pin); expect(await store.candidate(scope, 200n, WALLET)).toBeNull();
  });
  it("shares atomic request quotas across replicas and advances the rolling fixed window", async () => {
    const one = createPlatformTokenStore(a, a), two = createPlatformTokenStore(b, b);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? one : two).quota("test", 5, 60, 120)));
    expect(responses.filter(Boolean)).toHaveLength(5);
    expect(await one.quota("test", 5, 60, 180)).toBe(true);
  });
});
