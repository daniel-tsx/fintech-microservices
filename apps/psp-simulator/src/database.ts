import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './database.schema.js';

export type PspDatabase = PostgresJsDatabase<typeof schema>;
export type PspClient = Sql;

export function createPspDatabase(url: string): { client: PspClient; db: PspDatabase } {
  const client = postgres(url, { max: 10 });
  return { client, db: drizzle(client, { schema }) };
}
