// Optional audit runtime: npm install --prefix <temp-dir> --ignore-scripts --no-audit
// --no-fund --package-lock=false @electric-sql/pglite@0.5.9
// Set DUST_SWEEP_SQL_TEST_RUNTIME=<temp-dir>; no application dependency is added.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const searchPaths = [process.env.DUST_SWEEP_SQL_TEST_RUNTIME, __dirname].filter(Boolean);
const { PGlite } = require(require.resolve('@electric-sql/pglite', { paths: searchPaths }));
const sql = (name) => readFileSync(path.join(__dirname, '..', 'sql', name), 'utf8');
const seed = sql('multichain_optimism.sql');
const baseToken = `UPDATE public.tokens SET name='Base WETH audit',source='audit',liquidity_usd=123
  WHERE address='0x4200000000000000000000000000000000000006' AND chain_id=8453;`;

async function withDatabase(run) {
  const db = new PGlite();
  try {
    await db.exec(sql('dustsweep_schema.sql'));
    await db.exec(baseToken);
    await run(db);
  } finally {
    await db.close();
  }
}

test('Optimism seed applies twice, preserves other chains, and satisfies verification SQL', async () => {
  await withDatabase(async (db) => {
    for (const migration of ['ethereum', 'bsc', 'robinhood', 'arbitrum']) {
      await db.exec(sql(`multichain_${migration}.sql`));
    }
    const beforeTokens = await db.query('SELECT * FROM public.tokens WHERE chain_id <> 10 ORDER BY id');
    const beforeChains = await db.query('SELECT * FROM public.chain_registry WHERE chain_id <> 10 ORDER BY chain_id');
    await db.exec(seed);
    await db.exec(seed);
    assert.deepEqual((await db.query('SELECT * FROM public.tokens WHERE chain_id <> 10 ORDER BY id')).rows, beforeTokens.rows);
    assert.deepEqual((await db.query('SELECT * FROM public.chain_registry WHERE chain_id <> 10 ORDER BY chain_id')).rows, beforeChains.rows);
    const verified = await db.exec(sql('multichain_optimism_verify.sql'));
    assert.equal(verified[0].rows.length, 1);
    assert.equal(verified[0].rows[0].chain_slug, 'optimism');
    assert.equal(verified[1].rows.length, 8);
    assert.ok(verified[1].rows.every((row) => row.passed === true));
    assert.equal(verified[2].rows.length, 1);
    assert.equal(verified[3].rows.length, 2);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.tokens WHERE chain_id=10')).rows[0].count, 8);
    assert.equal((await db.query("SELECT symbol FROM public.tokens WHERE chain_id=10 AND lower(address)='0x01bff41798a0bcf287b996046ca68b395dbc1071'")).rows[0].symbol, 'USD₮0');
    assert.equal((await db.query("SELECT symbol FROM public.tokens WHERE chain_id=10 AND lower(address)='0x7f5c764cbc14f9669b88837ca1490cca17c31607'")).rows[0].symbol, 'USDC');
    await assert.rejects(db.query("INSERT INTO public.tokens(address,symbol,name,chain_id) VALUES ('0x4200000000000000000000000000000000000006','WETH','Duplicate',10)"), /duplicate key/);
  });
});

test('Optimism seed rejects the original globally unique schema without partial changes', async () => {
  await withDatabase(async (db) => {
    await assert.rejects(db.exec(seed), /Apply multichain_ethereum.sql before Optimism/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.chain_registry WHERE chain_id=10')).rows[0].count, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.tokens WHERE chain_id=10')).rows[0].count, 0);
    const base = (await db.query("SELECT symbol,liquidity_usd FROM public.tokens WHERE chain_id=8453 AND address='0x4200000000000000000000000000000000000006'")).rows[0];
    assert.equal(base.symbol, 'WETH');
    assert.equal(Number(base.liquidity_usd), 123);
  });
});

test('Optimism prerequisite guard catches a differently named global unique index', async () => {
  await withDatabase(async (db) => {
    await db.exec(sql('multichain_ethereum.sql'));
    await db.exec('CREATE UNIQUE INDEX audit_custom_address_unique ON public.tokens(address)');
    await assert.rejects(db.exec(seed), /Apply multichain_ethereum.sql before Optimism/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.tokens WHERE chain_id=10')).rows[0].count, 0);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM pg_indexes WHERE indexname='audit_custom_address_unique'")).rows[0].count, 1);
  });
});

test('a failed token insert rolls back the Optimism registry and all seed rows', async () => {
  await withDatabase(async (db) => {
    await db.exec(sql('multichain_ethereum.sql'));
    const before = (await db.query('SELECT * FROM public.tokens ORDER BY id')).rows;
    await db.exec("ALTER TABLE public.tokens ADD CONSTRAINT audit_reject_op CHECK (chain_id <> 10 OR symbol <> 'OP')");
    await assert.rejects(db.exec(seed), /audit_reject_op/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.chain_registry WHERE chain_id=10')).rows[0].count, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.tokens WHERE chain_id=10')).rows[0].count, 0);
    assert.deepEqual((await db.query('SELECT * FROM public.tokens ORDER BY id')).rows, before);
  });
});
