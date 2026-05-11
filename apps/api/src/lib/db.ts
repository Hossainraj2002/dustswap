import {
  Pool,
  types,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";

const PG_DATE_OID = 1082;
const PG_INT8_OID = 20;
const PG_TIMESTAMP_OID = 1114;
const PG_TIMESTAMPTZ_OID = 1184;

function normalizePgDateTimeText(value: string) {
  let normalized = value.includes(" ") ? value.replace(" ", "T") : value;
  if (/[+-]\d{2}$/.test(normalized)) {
    normalized += ":00";
  }
  return normalized;
}

function parsePgInt8(value: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL BIGINT exceeds JavaScript safe integer range: ${value}`);
  }
  return parsed;
}

// Supabase returned date/time columns as strings. Keep that shape so the app does
// not receive timezone-shifted Date objects from node-postgres.
types.setTypeParser(PG_INT8_OID, parsePgInt8);
types.setTypeParser(PG_DATE_OID, (value) => value);
types.setTypeParser(PG_TIMESTAMP_OID, normalizePgDateTimeText);
types.setTypeParser(PG_TIMESTAMPTZ_OID, normalizePgDateTimeText);

let pool: Pool | null = null;

function getDatabaseUrl() {
  return process.env.DATABASE_URL?.trim() || "";
}

function shouldUseSsl(databaseUrl: string) {
  const explicit = process.env.DATABASE_SSL_MODE?.trim().toLowerCase();
  if (explicit === "disable" || explicit === "false" || explicit === "0") {
    return false;
  }
  if (explicit === "require" || explicit === "true" || explicit === "1") {
    return true;
  }

  try {
    const parsed = new URL(databaseUrl);
    const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
    if (sslMode === "disable") return false;
    if (sslMode === "require" || sslMode === "verify-full" || sslMode === "verify-ca") {
      return true;
    }

    const host = parsed.hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return true;
  }
}

export function getDbPool() {
  if (pool) {
    return pool;
  }

  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for PostgreSQL access");
  }

  const config: PoolConfig = {
    connectionString,
    max: 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  };

  if (shouldUseSsl(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  }

  pool = new Pool(config);
  pool.on("error", (error) => {
    console.error("[DB] idle client error", error);
  });

  return pool;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<QueryResult<T>> {
  return getDbPool().query<T>(text, values);
}

export async function testDbConnection() {
  const startedAt = Date.now();
  await dbQuery("select 1");
  return Date.now() - startedAt;
}

export async function closeDbPool() {
  if (!pool) {
    return;
  }
  await pool.end();
  pool = null;
}
