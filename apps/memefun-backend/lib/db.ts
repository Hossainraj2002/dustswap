import pg from "pg";

import { optionalEnv, requireEnv } from "./env";

/**
 * Two pools on the one database:
 *   read pool : Ponder's tables (schema DATABASE_SCHEMA, "public" under `ponder dev`), read-only
 *               sessions with a statement timeout, for the read API and the keeper.
 *   app pool  : memefun_app (metadata, comments, reports, moderation, epochs), read-write.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,44}$/;

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
    max: options.max ?? 10,
    options: `-c search_path=${schema} -c default_transaction_read_only=on -c statement_timeout=${options.statementTimeoutMs ?? 5_000}`,
  });
}

export function createAppPool(options: { max?: number } = {}) {
  return new pg.Pool({
    connectionString: requireEnv("DATABASE_URL"),
    max: options.max ?? 10,
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
