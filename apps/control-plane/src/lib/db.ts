import pg from "pg";

import { config } from "./config";

const { Client, Pool } = pg;

declare global {
  var branchHarborPool: pg.Pool | undefined;
}

export const pool =
  global.branchHarborPool ??
  new Pool({
    connectionString: config.databaseUrl,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") {
  global.branchHarborPool = pool;
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}

export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withAdvisoryLock<T>(
  lockKey: string,
  callback: () => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    return await callback();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
    await client.end();
  }
}
