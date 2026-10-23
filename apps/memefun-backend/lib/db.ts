import pg from "pg";

import { envInt, optionalEnv, requireEnv } from "./env";

/**
 * Two pools on the one database:
 *   read pool : Ponder's tables (schema DATABASE_SCHEMA, "public" under `ponder dev`), read-only
 *               sessions with a statement timeout, for the read API and the keeper.
 *   app pool  : memefun_app (metadata, comments, reports, moderation, epochs), read-write.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,44}$/;

function poolIdleTimeoutMillis() {
  // This only releases checked-in idle clients. Transactions and advisory-lock clients that
  // are still checked out are never interrupted by the pool's idle timeout.
  return envInt("MEMEFUN_DB_IDLE_TIMEOUT_MS", 10_000, { min: 1_000, max: 60_000 });
}

export function ponderPoolConfig() {
  // Ponder reserves two internal connections and splits the remainder across three pools.
  // Keep at least two connections in each of those pools, even in the low-traffic preset.
  return {
    max: envInt("MEMEFUN_PONDER_POOL_MAX", 20, { min: 8, max: 100 }),
    idleTimeoutMillis: poolIdleTimeoutMillis(),
  };
}

export function readSchemaName(): string {
  const schema = optionalEnv("DATABASE_SCHEMA") ?? "public";
  if (!SCHEMA_NAME.test(schema)) throw new Error(`DATABASE_SCHEMA "${schema}" is not a plain lowercase identifier.`);
  return schema;
}

export function createReadPool(options: { schema?: string; max?: number; statementTimeoutMs?: number } = {}) {
  const schema = options.schema ?? readSchemaName();
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name "${schema}"`);
  return new pg.Pool({
    connectionString: requireEnv("DATABASE_URL"),
    max: options.max ?? envInt("MEMEFUN_DB_READ_POOL_MAX", 10, { min: 2, max: 100 }),
    idleTimeoutMillis: poolIdleTimeoutMillis(),
    options: `-c search_path=${schema} -c default_transaction_read_only=on -c statement_timeout=${options.statementTimeoutMs ?? 5_000}`,
  });
}

export function createAppPool(options: { max?: number } = {}) {
  return new pg.Pool({
    connectionString: requireEnv("DATABASE_URL"),
    max: options.max ?? envInt("MEMEFUN_DB_APP_POOL_MAX", 10, { min: 2, max: 100 }),
    idleTimeoutMillis: poolIdleTimeoutMillis(),
    options: "-c search_path=memefun_app -c statement_timeout=10000",
  });
}

export type Queryable = Pick<pg.Pool, "query">;

/** Rows of a query, typed by the caller. */
export async function rows<T>(db: Queryable, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[];
}

export const big = (value: string | number | bigint | null | undefined): bigint =>
  value === null || value === undefined ? 0n : BigInt(value);
