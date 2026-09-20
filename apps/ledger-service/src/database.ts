import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './database.schema.js';

export type LedgerDatabase = PostgresJsDatabase<typeof schema>;
export type LedgerPostgresClient = ReturnType<typeof postgres>;

export function createLedgerDatabase(connectionString: string): { client: LedgerPostgresClient; db: LedgerDatabase } {
  const client = postgres(connectionString, { max: 10, idle_timeout: 20, connect_timeout: 10 });
  return { client, db: drizzle(client, { schema }) };
}
