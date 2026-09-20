import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

const services = [
  { database: 'payments', directory: 'apps/payment-service/migrations', baselineTable: 'payments' },
  { database: 'wallets', directory: 'apps/wallet-service/migrations', baselineTable: 'wallets' },
  { database: 'ledger', directory: 'apps/ledger-service/migrations', baselineTable: 'ledger_accounts' },
  { database: 'psp', directory: 'apps/psp-simulator/migrations', baselineTable: 'psp_operations' },
  { database: 'reconciliation', directory: 'apps/reconciliation-service/migrations', baselineTable: 'reconciliation_runs' },
];

const adminUrl = new URL(process.env.DATABASE_ADMIN_URL ?? 'postgres://ledgerflow:ledgerflow@localhost:5432/postgres');

for (const service of services) {
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${service.database}`;
  const client = postgres(databaseUrl.toString(), { max: 1 });
  try {
    await client`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const migrationDirectory = resolve(service.directory);
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
    const migrationRows = await client<{ migration_count: number }[]>`SELECT COUNT(*)::int AS migration_count FROM schema_migrations`;
    const tableRows = await client<{ table_name: string | null }[]>`SELECT to_regclass(${`public.${service.baselineTable}`})::text AS table_name`;
    const migrationCount = migrationRows[0]?.migration_count ?? 0;
    const tableName = tableRows[0]?.table_name ?? null;
    const firstMigration = files[0];
    if (migrationCount === 0 && tableName !== null && firstMigration !== undefined) {
      const firstSql = await readFile(resolve(migrationDirectory, firstMigration), 'utf8');
      const firstChecksum = createHash('sha256').update(firstSql).digest('hex');
      await client`INSERT INTO schema_migrations (migration_name, checksum) VALUES (${firstMigration}, ${firstChecksum})`;
      console.log(JSON.stringify({ level: 'info', message: 'existing schema baselined', database: service.database, migration: firstMigration }));
    }
    for (const file of files) {
      const sql = await readFile(resolve(migrationDirectory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const [existing] = await client<{ checksum: string }[]>`SELECT checksum FROM schema_migrations WHERE migration_name = ${file}`;
      if (existing !== undefined) {
        if (existing.checksum !== checksum) throw new Error(`Migration ${service.database}/${file} changed after it was applied`);
        continue;
      }
      await client.begin(async (transaction) => {
        await transaction.unsafe(sql);
        await transaction`INSERT INTO schema_migrations (migration_name, checksum) VALUES (${file}, ${checksum})`;
      });
      console.log(JSON.stringify({ level: 'info', message: 'migration applied', database: service.database, migration: file }));
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
