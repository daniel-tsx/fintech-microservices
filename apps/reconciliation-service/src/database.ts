import postgres from 'postgres';

export type ReconciliationDatabase = ReturnType<typeof postgres>;
export type ReconciliationTransaction = postgres.TransactionSql;
export type ReconciliationJson = postgres.JSONValue;

export function createReconciliationDatabase(connectionString: string): ReconciliationDatabase {
  return postgres(connectionString, { max: 10, idle_timeout: 20, connect_timeout: 10 });
}
