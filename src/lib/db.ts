import { neon } from '@neondatabase/serverless';

let _sql: ReturnType<typeof neon> | null = null;
function client() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL ontbreekt');
    _sql = neon(url);
  }
  return _sql;
}

// Parameterized query: q('SELECT * FROM t WHERE id = $1', [id]) → rows
export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  return (await client().query(text, params)) as T[];
}
export async function q1<T = any>(text: string, params: any[] = []): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}
