import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/**
 * Applies migrations/NNNN_name.sql in order, each once and in its own transaction, under an
 * advisory lock so concurrent deploys never race. A migration whose file changed after it was
 * applied stops everything: migrations are append-only.
 */
export async function migrate(pool: pg.Pool, dir: string | URL = MIGRATIONS_DIR): Promise<string[]> {
  const path = typeof dir === "string" ? dir : fileURLToPath(dir);
  const files = readdirSync(path)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('memefun_app_migrate'))");
    await client.query("CREATE SCHEMA IF NOT EXISTS memefun_app");
    await client.query(
      "CREATE TABLE IF NOT EXISTS memefun_app.schema_migration (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Map(
      (await client.query<{ id: string; checksum: string }>("SELECT id, checksum FROM memefun_app.schema_migration")).rows.map((r) => [r.id, r.checksum]),
    );
    for (const name of files) {
      const sql = readFileSync(join(path, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = done.get(name);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`migration ${name} changed after it was applied; add a new migration instead`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO memefun_app.schema_migration (id, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('memefun_app_migrate'))").catch(() => undefined);
    client.release();
  }
}
