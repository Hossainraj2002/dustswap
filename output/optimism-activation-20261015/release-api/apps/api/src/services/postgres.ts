import { dbQuery } from "../lib/db";

type DbError = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

type DbResponse<T = any> = {
  data: any;
  error: DbError | null;
  count?: number | null;
};

type SelectOptions = {
  count?: "exact" | null;
  head?: boolean;
};

type UpsertOptions = {
  onConflict?: string;
  ignoreDuplicates?: boolean;
};

type Filter = {
  sql: string;
  values: unknown[];
};

type OrderClause = {
  column: string;
  ascending: boolean;
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function toDbError(error: unknown): DbError {
  const anyError = error as { message?: unknown; code?: unknown; detail?: unknown; details?: unknown; hint?: unknown };
  return {
    message: String(anyError?.message || error || "Database query failed"),
    code: typeof anyError?.code === "string" ? anyError.code : undefined,
    details:
      typeof anyError?.details === "string"
        ? anyError.details
        : typeof anyError?.detail === "string"
          ? anyError.detail
          : undefined,
    hint: typeof anyError?.hint === "string" ? anyError.hint : undefined,
  };
}

function quoteIdent(identifier: string) {
  const trimmed = identifier.trim();
  if (!IDENTIFIER_RE.test(trimmed)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function quoteQualifiedIdentifier(identifier: string) {
  return identifier
    .split(".")
    .map((part) => quoteIdent(part))
    .join(".");
}

function normalizeSelectColumns(columns?: string | null) {
  const value = (columns || "*").trim();
  if (!value || value === "*") {
    return "*";
  }

  return value
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
    .map((column) => quoteQualifiedIdentifier(column))
    .join(", ");
}

function normalizeRows(payload: unknown) {
  const rows = Array.isArray(payload) ? payload : [payload];
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Insert/update payload must be an object or object array");
    }
    return Object.fromEntries(
      Object.entries(row as Record<string, unknown>).filter(([, value]) => value !== undefined)
    );
  });
}

function isJsonWriteValue(value: unknown) {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  );
}

function pushWriteValue(values: unknown[], value: unknown) {
  if (isJsonWriteValue(value)) {
    values.push(JSON.stringify(value));
    return `$${values.length}::jsonb`;
  }

  values.push(value);
  return `$${values.length}`;
}

function parseFilterValue(value: string) {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function makeComparison(column: string, operator: string, value: unknown): Filter {
  const lhs = quoteIdent(column);
  switch (operator) {
    case "eq":
      return { sql: `${lhs} = $1`, values: [value] };
    case "neq":
      return { sql: `${lhs} <> $1`, values: [value] };
    case "gt":
      return { sql: `${lhs} > $1`, values: [value] };
    case "gte":
      return { sql: `${lhs} >= $1`, values: [value] };
    case "lt":
      return { sql: `${lhs} < $1`, values: [value] };
    case "lte":
      return { sql: `${lhs} <= $1`, values: [value] };
    case "like":
      return { sql: `${lhs} LIKE $1`, values: [value] };
    case "ilike":
      return { sql: `${lhs} ILIKE $1`, values: [value] };
    default:
      throw new Error(`Unsupported filter operator: ${operator}`);
  }
}

function shiftPlaceholders(sql: string, offset: number) {
  return sql.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + offset}`);
}

function bindFilters(filters: Filter[], values: unknown[]) {
  if (!filters.length) {
    return "";
  }

  const parts = filters.map((filter) => {
    const sql = shiftPlaceholders(filter.sql, values.length);
    values.push(...filter.values);
    return sql;
  });

  return ` WHERE ${parts.join(" AND ")}`;
}

function singleError(message: string): DbError {
  return {
    code: "PGRST116",
    message,
  };
}

class PgQueryBuilder<T = any> implements PromiseLike<DbResponse<T>> {
  private operation: "select" | "insert" | "upsert" | "update" | "delete" | null = null;
  private selectedColumns = "*";
  private selectOptions: SelectOptions = {};
  private payload: unknown;
  private upsertOptions: UpsertOptions = {};
  private filters: Filter[] = [];
  private orderClauses: OrderClause[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;

  constructor(private readonly tableName: string) {}

  select(columns?: string, options: SelectOptions = {}) {
    if (!this.operation) {
      this.operation = "select";
    }
    this.selectedColumns = normalizeSelectColumns(columns);
    this.selectOptions = options;
    return this;
  }

  insert(payload: unknown) {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  upsert(payload: unknown, options: UpsertOptions = {}) {
    this.operation = "upsert";
    this.payload = payload;
    this.upsertOptions = options;
    return this;
  }

  update(payload: unknown) {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push(makeComparison(column, "eq", value));
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push(makeComparison(column, "neq", value));
    return this;
  }

  gt(column: string, value: unknown) {
    this.filters.push(makeComparison(column, "gt", value));
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push(makeComparison(column, "gte", value));
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push(makeComparison(column, "lt", value));
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push(makeComparison(column, "lte", value));
    return this;
  }

  like(column: string, value: unknown) {
    this.filters.push(makeComparison(column, "like", value));
    return this;
  }

  ilike(column: string, value: unknown) {
    this.filters.push(makeComparison(column, "ilike", value));
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({
      sql: value === null ? `${quoteIdent(column)} IS NULL` : `${quoteIdent(column)} IS NOT DISTINCT FROM $1`,
      values: value === null ? [] : [value],
    });
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    if (operator === "is" && value === null) {
      this.filters.push({ sql: `${quoteIdent(column)} IS NOT NULL`, values: [] });
      return this;
    }
    const comparison = makeComparison(column, operator, value);
    this.filters.push({
      sql: `NOT (${comparison.sql})`,
      values: comparison.values,
    });
    return this;
  }

  in(column: string, values: unknown[]) {
    if (!values.length) {
      this.filters.push({ sql: "false", values: [] });
      return this;
    }
    this.filters.push({
      sql: `${quoteIdent(column)} = ANY($1)`,
      values: [values],
    });
    return this;
  }

  contains(column: string, value: unknown) {
    this.filters.push({
      sql: `${quoteIdent(column)} @> $1::jsonb`,
      values: [JSON.stringify(value)],
    });
    return this;
  }

  or(filterText: string) {
    const parts = filterText
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [column, op, maybeNestedOp, ...rest] = part.split(".");
        if (op === "not" && maybeNestedOp === "is") {
          const value = parseFilterValue(rest.join("."));
          if (value === null) {
            return { sql: `${quoteIdent(column)} IS NOT NULL`, values: [] };
          }
          return { sql: `${quoteIdent(column)} IS DISTINCT FROM $1`, values: [value] };
        }

        return makeComparison(column, op, parseFilterValue([maybeNestedOp, ...rest].join(".")));
      });

    if (parts.length) {
      const values: unknown[] = [];
      const sql = parts
        .map((part) => {
          const shifted = shiftPlaceholders(part.sql, values.length);
          values.push(...part.values);
          return shifted;
        })
        .join(" OR ");
      this.filters.push({ sql: `(${sql})`, values });
    }

    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderClauses.push({
      column,
      ascending: options.ascending !== false,
    });
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this;
  }

  range(from: number, to: number) {
    this.offsetValue = from;
    this.limitValue = Math.max(0, to - from + 1);
    return this;
  }

  single() {
    this.singleMode = "single";
    return this;
  }

  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this;
  }

  then<TResult1 = DbResponse<T>, TResult2 = never>(
    onfulfilled?: ((value: DbResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ) {
    return this.execute().catch(onrejected);
  }

  private async execute(): Promise<DbResponse<T>> {
    try {
      switch (this.operation || "select") {
        case "select":
          return await this.executeSelect();
        case "insert":
          return await this.executeInsert(false);
        case "upsert":
          return await this.executeInsert(true);
        case "update":
          return await this.executeUpdate();
        case "delete":
          return await this.executeDelete();
        default:
          return { data: null, error: { message: "Unsupported database operation" } };
      }
    } catch (error) {
      return { data: null, error: toDbError(error), count: null };
    }
  }

  private tableSql() {
    return quoteQualifiedIdentifier(this.tableName);
  }

  private applyOrderLimit(values: unknown[]) {
    let sql = "";
    if (this.orderClauses.length) {
      sql += ` ORDER BY ${this.orderClauses
        .map((order) => `${quoteIdent(order.column)} ${order.ascending ? "ASC" : "DESC"}`)
        .join(", ")}`;
    }
    if (this.limitValue !== null) {
      values.push(this.limitValue);
      sql += ` LIMIT $${values.length}`;
    }
    if (this.offsetValue !== null) {
      values.push(this.offsetValue);
      sql += ` OFFSET $${values.length}`;
    }
    return sql;
  }

  private normalizeData(rows: unknown[]): DbResponse<T> {
    if (this.singleMode === "maybeSingle") {
      if (rows.length > 1) {
        return { data: null, error: singleError("JSON object requested, multiple rows returned") };
      }
      return { data: (rows[0] ?? null) as T | null, error: null };
    }
    if (this.singleMode === "single") {
      if (rows.length !== 1) {
        return { data: null, error: singleError("JSON object requested, zero or multiple rows returned") };
      }
      return { data: rows[0] as T, error: null };
    }
    return { data: rows as T, error: null };
  }

  private async executeSelect(): Promise<DbResponse<T>> {
    const values: unknown[] = [];
    const where = bindFilters(this.filters, values);
    const countRequested = this.selectOptions.count === "exact";

    let count: number | null = null;
    if (countRequested) {
      const countResult = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::bigint AS count FROM ${this.tableSql()}${where}`,
        values
      );
      count = Number(countResult.rows[0]?.count || 0);
    }

    if (this.selectOptions.head) {
      return { data: null, error: null, count };
    }

    const dataValues = [...values];
    const sql =
      `SELECT ${this.selectedColumns} FROM ${this.tableSql()}${where}` +
      this.applyOrderLimit(dataValues);
    const result = await dbQuery(sql, dataValues);
    return { ...this.normalizeData(result.rows), count };
  }

  private async executeInsert(isUpsert: boolean): Promise<DbResponse<T>> {
    const rows = normalizeRows(this.payload);
    if (!rows.length) {
      return { data: [], error: null } as DbResponse<T>;
    }

    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (!columns.length) {
      return { data: null, error: { message: "Insert payload has no columns" } };
    }

    const values: unknown[] = [];
    const tuples = rows.map((row) => {
      const placeholders = columns.map((column) => {
        return pushWriteValue(values, row[column] ?? null);
      });
      return `(${placeholders.join(", ")})`;
    });

    const quotedColumns = columns.map(quoteIdent).join(", ");
    let sql = `INSERT INTO ${this.tableSql()} (${quotedColumns}) VALUES ${tuples.join(", ")}`;

    if (isUpsert) {
      const conflictColumns = (this.upsertOptions.onConflict || "")
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean);
      if (!conflictColumns.length) {
        return { data: null, error: { message: "Upsert requires onConflict columns" } };
      }
      sql += ` ON CONFLICT (${conflictColumns.map(quoteIdent).join(", ")})`;
      if (this.upsertOptions.ignoreDuplicates) {
        sql += " DO NOTHING";
      } else {
        const updates = columns
          .filter((column) => !conflictColumns.includes(column))
          .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`);
        sql += updates.length ? ` DO UPDATE SET ${updates.join(", ")}` : " DO NOTHING";
      }
    }

    const wantsReturn = this.selectedColumns !== "*"
      || this.singleMode !== null
      || this.operation === "upsert";
    if (wantsReturn) {
      sql += ` RETURNING ${this.selectedColumns}`;
    }

    const result = await dbQuery(sql, values);
    return wantsReturn ? this.normalizeData(result.rows) : ({ data: null, error: null } as DbResponse<T>);
  }

  private async executeUpdate(): Promise<DbResponse<T>> {
    const rows = normalizeRows(this.payload);
    const row = rows[0] || {};
    const columns = Object.keys(row);
    if (!columns.length) {
      return { data: null, error: { message: "Update payload has no columns" } };
    }

    const values: unknown[] = [];
    const assignments = columns.map((column) => {
      const placeholder = pushWriteValue(values, row[column]);
      return `${quoteIdent(column)} = ${placeholder}`;
    });

    const where = bindFilters(this.filters, values);
    let sql = `UPDATE ${this.tableSql()} SET ${assignments.join(", ")}${where}`;
    const wantsReturn = this.selectedColumns !== "*" || this.singleMode !== null;
    if (wantsReturn) {
      sql += ` RETURNING ${this.selectedColumns}`;
    }

    const result = await dbQuery(sql, values);
    return wantsReturn ? this.normalizeData(result.rows) : ({ data: null, error: null } as DbResponse<T>);
  }

  private async executeDelete(): Promise<DbResponse<T>> {
    const values: unknown[] = [];
    const where = bindFilters(this.filters, values);
    const sql = `DELETE FROM ${this.tableSql()}${where}`;
    await dbQuery(sql, values);
    return { data: null, error: null };
  }
}

class PgPostgresAdapter {
  from<T = any>(tableName: string) {
    return new PgQueryBuilder<T>(tableName);
  }

  async rpc<T = any>(functionName: string, args: Record<string, unknown> = {}): Promise<DbResponse<T>> {
    try {
      const entries = Object.entries(args).filter(([, value]) => value !== undefined);
      const values = entries.map(([, value]) => value);
      const argSql = entries
        .map(([name], index) => `${quoteIdent(name)} => $${index + 1}`)
        .join(", ");
      const sql = `SELECT * FROM ${quoteQualifiedIdentifier(`public.${functionName}`)}(${argSql})`;
      const result = await dbQuery(sql, values);

      if (result.rows.length === 1) {
        const keys = Object.keys(result.rows[0] || {});
        if (keys.length === 1 && keys[0] === functionName) {
          return { data: result.rows[0][keys[0]] as T, error: null };
        }
      }

      return { data: result.rows as T, error: null };
    } catch (error) {
      return { data: null, error: toDbError(error) };
    }
  }
}

export function getDatabaseDiagnostics() {
  let urlRef = "missing";
  const databaseUrl = process.env.DATABASE_URL?.trim();
  try {
    urlRef = databaseUrl ? new URL(databaseUrl).hostname : "missing";
  } catch {
    urlRef = "invalid-url";
  }

  return {
    loadedEnv: databaseUrl ? "DATABASE_URL" : "missing",
    urlRef,
    keyType: "postgres",
  };
}

export const postgresDb = new PgPostgresAdapter();
