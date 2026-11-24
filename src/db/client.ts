/**
 * Database access helper.
 *
 * The Worker talks to D1 through the **raw binding** (`env.DB`) using prepared statements
 * and `env.DB.batch([...])`. That is deliberate: it keeps every query explicit, stays well
 * inside D1's 50-queries-per-invocation and 100-bound-parameters limits, and avoids pulling
 * a query builder into the hot path (hard rules #4/#5).
 *
 * Drizzle still owns the **schema** (`src/db/schema.ts`) — `drizzle-kit generate` emits the
 * migrations from it. This module is only about *running* SQL, and exists so route/service
 * modules do not each reach into `env.DB` directly.
 */

/**
 * Return the D1 binding as-is. The indirection is intentional: it gives a single, greppable
 * place to change how the database is obtained (e.g. a future wrapper) without touching
 * every call site, and it documents that all access goes through prepared statements.
 */
export function getDb(db: D1Database): D1Database {
  return db;
}

/**
 * Run a prepared statement and return its first row (or `null`). Thin wrapper over
 * `D1PreparedStatement.first` for readability at call sites.
 */
export async function firstRow<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  return getDb(db)
    .prepare(sql)
    .bind(...params)
    .first<T>();
}

/**
 * Run a prepared statement and return all rows. `results` is always an array (D1 returns an
 * empty one when nothing matches), so callers never need a null check.
 */
export async function allRows<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const { results } = await getDb(db)
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return results ?? [];
}

/** Run a single prepared statement (write) and return its result metadata. */
export async function runStatement(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<D1Result<unknown>> {
  return getDb(db)
    .prepare(sql)
    .bind(...params)
    .run();
}
