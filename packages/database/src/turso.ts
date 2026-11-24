/**
 * Zero-dependency Turso (libSQL) Hrana v2 HTTP pipeline client implementing
 * Cloudflare's D1Database interface.
 *
 * Works identically in Cloudflare Workers and Node.js (`tsx`), keeps `db.batch(...)`
 * to a single HTTP round-trip, and lets Swisshost switch seamlessly between D1
 * and Turso via `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`.
 */

type HranaArg =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

interface HranaColumn {
  name: string | null;
  decltype?: string | null;
}

interface HranaResult {
  cols: HranaColumn[];
  rows: HranaArg[][];
  affected_row_count: number;
  last_insert_rowid: string | null;
}

interface HranaPipelineResponse {
  results: Array<
    | { type: "ok"; response: { type: "execute"; result: HranaResult } | { type: "close" } }
    | { type: "error"; error: { message: string; code?: string } }
  >;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function encodeHranaArg(value: unknown): HranaArg {
  if (value === null || value === undefined) {
    return { type: "null" };
  }
  if (typeof value === "boolean") {
    return { type: "integer", value: value ? "1" : "0" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { type: "null" };
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      return { type: "integer", value: String(value) };
    }
    return { type: "float", value };
  }
  if (typeof value === "bigint") {
    return { type: "integer", value: value.toString() };
  }
  if (typeof value === "string") {
    return { type: "text", value };
  }
  if (value instanceof Uint8Array) {
    return { type: "blob", base64: bytesToBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "blob", base64: bytesToBase64(new Uint8Array(value)) };
  }
  return { type: "text", value: String(value) };
}

export function decodeHranaValue(cell: HranaArg): unknown {
  switch (cell.type) {
    case "null":
      return null;
    case "integer":
      return Number(cell.value);
    case "float":
      return Number(cell.value);
    case "text":
      return cell.value;
    case "blob":
      return base64ToBytes(cell.base64);
    default:
      return null;
  }
}

function decodeRows<T = Record<string, unknown>>(result: HranaResult): T[] {
  const colNames = result.cols.map((c, idx) => c.name ?? `col_${idx}`);
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < colNames.length; i++) {
      obj[colNames[i]!] = row[i] ? decodeHranaValue(row[i]!) : null;
    }
    return obj as T;
  });
}

function toPipelineUrl(databaseUrl: string): string {
  const trimmed = databaseUrl.trim().replace(/\/+$/, "");
  const httpUrl = trimmed
    .replace(/^libsql:\/\//i, "https://")
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
  return httpUrl.endsWith("/v2/pipeline") ? httpUrl : `${httpUrl}/v2/pipeline`;
}

function makeMeta(res: HranaResult, durationMs: number): D1Meta & Record<string, unknown> {
  return {
    duration: durationMs,
    size_after: 0,
    rows_read: res.rows.length,
    rows_written: res.affected_row_count ?? 0,
    last_row_id: res.last_insert_rowid ? Number(res.last_insert_rowid) : 0,
    changed_db: (res.affected_row_count ?? 0) > 0,
    changes: res.affected_row_count ?? 0,
  };
}

class TursoPreparedStatement {
  readonly sql: string;
  readonly params: unknown[];
  private readonly executeBatch: (stmts: Array<{ sql: string; params: unknown[] }>) => Promise<{
    results: HranaResult[];
    durationMs: number;
  }>;

  constructor(
    sql: string,
    params: unknown[],
    executeBatch: (stmts: Array<{ sql: string; params: unknown[] }>) => Promise<{
      results: HranaResult[];
      durationMs: number;
    }>
  ) {
    this.sql = sql;
    this.params = params;
    this.executeBatch = executeBatch;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new TursoPreparedStatement(
      this.sql,
      values,
      this.executeBatch
    ) as unknown as D1PreparedStatement;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const { results } = await this.executeBatch([{ sql: this.sql, params: this.params }]);
    const firstRes = results[0];
    if (!firstRes || firstRes.rows.length === 0) return null;
    const rows = decodeRows<Record<string, unknown>>(firstRes);
    const row = rows[0] ?? null;
    if (!row) return null;
    if (colName !== undefined) {
      return (row[colName] as T) ?? null;
    }
    return row as unknown as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { results, durationMs } = await this.executeBatch([{ sql: this.sql, params: this.params }]);
    const res = results[0]!;
    return {
      results: decodeRows<T>(res),
      success: true,
      meta: makeMeta(res, durationMs),
    };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.run<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const { results } = await this.executeBatch([{ sql: this.sql, params: this.params }]);
    const res = results[0]!;
    const out: unknown[][] = [];
    if (options?.columnNames) {
      out.push(res.cols.map((c, idx) => c.name ?? `col_${idx}`));
    }
    for (const row of res.rows) {
      out.push(row.map((cell) => decodeHranaValue(cell)));
    }
    return out as T[];
  }
}

export function createTursoD1Adapter(
  databaseUrl: string,
  authToken: string,
  fetchImpl: typeof fetch = fetch
): D1Database {
  const endpoint = toPipelineUrl(databaseUrl);

  const executeBatch = async (
    stmts: Array<{ sql: string; params: unknown[] }>
  ): Promise<{ results: HranaResult[]; durationMs: number }> => {
    if (stmts.length === 0) return { results: [], durationMs: 0 };
    const startMs = Date.now();
    const requests = [
      ...stmts.map((s) => ({
        type: "execute" as const,
        stmt: {
          sql: s.sql,
          args: s.params.map(encodeHranaArg),
        },
      })),
      { type: "close" as const },
    ];

    const resp = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`Turso HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }

    const payload = (await resp.json()) as HranaPipelineResponse;
    const durationMs = Date.now() - startMs;
    const out: HranaResult[] = [];

    for (let i = 0; i < stmts.length; i++) {
      const item = payload.results[i];
      if (!item) {
        throw new Error(`Turso pipeline missing result for statement #${i}`);
      }
      if (item.type === "error") {
        throw new Error(`Turso SQL error: ${item.error.message}`);
      }
      if (item.response.type === "execute") {
        out.push(item.response.result);
      }
    }

    return { results: out, durationMs };
  };

  const adapter = {
    prepare(query: string): D1PreparedStatement {
      return new TursoPreparedStatement(query, [], executeBatch) as unknown as D1PreparedStatement;
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      if (statements.length === 0) return [];
      const specs = statements.map((s) => {
        const ts = s as unknown as TursoPreparedStatement;
        return { sql: ts.sql, params: ts.params };
      });
      const { results, durationMs } = await executeBatch(specs);
      return results.map((res) => ({
        results: decodeRows<T>(res),
        success: true,
        meta: makeMeta(res, durationMs),
      }));
    },

    async exec(query: string): Promise<D1ExecResult> {
      const stmts = splitSqlStatements(query);
      if (stmts.length === 0) return { count: 0, duration: 0 };
      const { durationMs } = await executeBatch(stmts.map((sql) => ({ sql, params: [] })));
      return { count: stmts.length, duration: durationMs };
    },

    async dump(): Promise<ArrayBuffer> {
      throw new Error("D1 dump() is not supported on Turso HTTP adapter");
    },
  };

  return adapter as unknown as D1Database;
}

/**
 * Splits a multi-statement SQL script into individual statements while respecting
 * single-quoted string literals and `--` line comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = [];
  let cur = "";
  let inSingle = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (!inSingle && ch === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      cur += ch;
      if (inSingle && next === "'") {
        cur += next;
        i++;
      } else {
        inSingle = !inSingle;
      }
      continue;
    }

    if (!inSingle && ch === ";") {
      const trimmed = cur.trim();
      if (trimmed) stmts.push(trimmed);
      cur = "";
      continue;
    }

    cur += ch;
  }

  const tail = cur.trim();
  if (tail) stmts.push(tail);
  return stmts;
}
