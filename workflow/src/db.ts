import { db, type Tx } from "../../lib/database";

export { db, type Tx };
type SQLParam =
  | string
  | number
  | boolean
  | bigint
  | Date
  | Record<string, unknown>
  | null
  | undefined;

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.begin();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function queryOne<T extends object>(
  tx: Tx,
  sql: string,
  values: SQLParam[]
): Promise<T | null> {
  return tx.rawQueryRow<T>(sql, ...values);
}
