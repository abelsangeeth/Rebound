import pg from 'pg';
import { env } from './env.js';

// Money is BIGINT paise everywhere. node-postgres hands back BIGINT as a
// string to avoid silent precision loss; we want real numbers, and paise
// amounts are nowhere near 2^53, so parse them.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 12 });

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** Run fn inside a transaction, rolling back on any throw. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export const UNIQUE_VIOLATION = '23505';
export const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;
