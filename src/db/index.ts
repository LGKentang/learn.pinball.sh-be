import pg from 'pg';
import { env } from '../env.js';
import { MIGRATIONS } from './migrations.js';

/**
 * count(*) and sum() come back as bigint, which node-postgres hands over as a
 * string to avoid losing precision past 2^53. Every bigint we select is a row
 * count, so parse them as numbers and keep the API shape identical to before.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Managed Postgres (RDS, Neon, Supabase) terminates TLS with its own CA. Opt in
  // explicitly rather than silently accepting any certificate.
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  // An idle client dying is normal after a failover; the pool replaces it.
  console.error('[db] idle client error:', err.message);
});

export type Param = string | number | boolean | null | Date | undefined;

/** Every row of a query. */
export async function rows<T>(sql: string, params: Param[] = []): Promise<T[]> {
  const res = await pool.query(sql, params as unknown[]);
  return res.rows as T[];
}

/** The first row, or undefined. */
export async function row<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
  const res = await pool.query(sql, params as unknown[]);
  return (res.rows[0] as T | undefined) ?? undefined;
}

/** How many rows a write touched — the Postgres answer to SQLite's `changes`. */
export async function count(sql: string, params: Param[] = []): Promise<number> {
  const res = await pool.query(sql, params as unknown[]);
  return res.rowCount ?? 0;
}

export interface Tx {
  rows: <T>(sql: string, params?: Param[]) => Promise<T[]>;
  row: <T>(sql: string, params?: Param[]) => Promise<T | undefined>;
  count: (sql: string, params?: Param[]) => Promise<number>;
}

/**
 * Run fn against a single pooled client inside a transaction. Taking a client for
 * the whole callback is the point: interleaving a transaction with pool.query()
 * would send statements down other connections and silently escape the BEGIN.
 */
export async function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const t: Tx = {
    rows: async <R,>(sql: string, params: Param[] = []) =>
      (await client.query(sql, params as unknown[])).rows as R[],
    row: async <R,>(sql: string, params: Param[] = []) =>
      ((await client.query(sql, params as unknown[])).rows[0] as R | undefined) ?? undefined,
    count: async (sql: string, params: Param[] = []) =>
      (await client.query(sql, params as unknown[])).rowCount ?? 0,
  };
  try {
    await client.query('BEGIN');
    const out = await fn(t);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Ids are generated here rather than by the database, so they are stable across engines. */
export const newId = (): string => crypto.randomUUID();

export const now = (): string => new Date().toISOString();

/**
 * Apply any migration not yet recorded. An advisory lock makes this safe when
 * several API containers boot at once: the others wait, then find nothing to do.
 */
export async function migrate(log: (msg: string) => void = console.log): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [0x7011_6a11]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        id         TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (await client.query<{ id: string }>('SELECT id FROM schema_migration')).rows.map((r) => r.id),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migration (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        log(`[db] applied ${m.id}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${m.id} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [0x7011_6a11]).catch(() => undefined);
    client.release();
  }
}
