import { Pool, type PoolClient, type QueryResultRow } from "pg";

type SQLParam =
  | string
  | number
  | boolean
  | bigint
  | Date
  | Record<string, unknown>
  | null
  | undefined;

let pool: Pool | undefined;

export type Tx = PoolClient;

function getPool(): Pool {
  pool ??= new Pool({
    connectionString: requireDatabaseUrl()
  });

  return pool;
}

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is required to run workflow activities");
  }
  return value;
}

export const db = {
  async rawExec(sql: string, ...values: SQLParam[]): Promise<void> {
    await getPool().query(sql, values);
  },

  async rawQueryRow<T extends QueryResultRow>(
    sql: string,
    ...values: SQLParam[]
  ): Promise<T | null> {
    const result = await getPool().query<T>(sql, values);
    return result.rows[0] ?? null;
  }
};

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await getPool().connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  tx: Tx,
  sql: string,
  values: SQLParam[]
): Promise<T | null> {
  const result = await tx.query<T>(sql, values);
  return result.rows[0] ?? null;
}
