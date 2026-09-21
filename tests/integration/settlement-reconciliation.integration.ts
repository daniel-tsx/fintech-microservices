import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SettlementStatementSimulator } from '../../apps/psp-simulator/src/settlement-statement.js';
import { createReconciliationDatabase } from '../../apps/reconciliation-service/src/database.js';
import { ReconciliationStore, RunLeaseUnavailableError, statementSourceDigest } from '../../apps/reconciliation-service/src/reconciliation.store.js';
import type { ReconciliationResult } from '../../apps/reconciliation-service/src/reconciliation.service.js';

const url = process.env.RECONCILIATION_TEST_DATABASE_URL ?? 'postgres://ledgerflow:ledgerflow@127.0.0.1:5432/reconciliation';
const connection = createReconciliationDatabase(url);
const store = new ReconciliationStore(connection);

async function reset(): Promise<void> {
  const client = postgres(url, { max: 1 });
  try {
    await client.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    for (const migration of ['apps/reconciliation-service/migrations/0001_reconciliation.sql', 'apps/reconciliation-service/migrations/0002_settlement_and_reconciliation.sql']) await client.unsafe(await readFile(resolve(migration), 'utf8'));
  } finally { await client.end(); }
}

describe.sequential('durable settlement and reconciliation', () => {
  const paymentId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const statement = new SettlementStatementSimulator('integration-secret', () => new Date('2026-01-02T00:00:00Z')).generate({
    providerSettlementId: 'integration-batch-1', windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-02T00:00:00Z', currency: 'USD',
    records: [{ externalPaymentId: crypto.randomUUID(), operationId, paymentId, operation: 'CAPTURE', amountMinor: 10_000, currency: 'USD', status: 'SUCCEEDED', providerSequence: 1, createdAt: '2026-01-01T01:00:00Z' }],
  });
  let batchId = '';

  beforeAll(async () => { await reset(); });
  afterAll(async () => { await connection.end(); });

  it('deduplicates a delivered-twice statement by stable provider identity and digest', async () => {
    const first = await store.ingestStatement(statement, true, []); batchId = first.batchId;
    const second = await store.ingestStatement(statement, true, []);
    expect(first.duplicate).toBe(false); expect(second).toEqual({ batchId, duplicate: true });
    const rows = await connection<{ batches: number; items: number }[]>`SELECT (SELECT COUNT(*)::int FROM settlement_batches) batches, (SELECT COUNT(*)::int FROM settlement_items) items`;
    expect(rows[0]).toEqual({ batches: 1, items: 1 });
  });

  it('deduplicates a run and prevents concurrent lease ownership', async () => {
    const sourceDigest = await statementSourceDigest(statement);
    const first = await store.createRun({ provider: statement.provider, batchId, windowStart: statement.windowStart, windowEnd: statement.windowEnd, sourceDigest });
    const replay = await store.createRun({ provider: statement.provider, batchId, windowStart: statement.windowStart, windowEnd: statement.windowEnd, sourceDigest });
    expect(replay).toEqual({ runId: first.runId, duplicate: true, status: 'CREATED' });
    await store.acquireRunLease(first.runId, 'worker-a');
    await expect(store.acquireRunLease(first.runId, 'worker-b')).rejects.toBeInstanceOf(RunLeaseUnavailableError);
  });

  it('emits one settlement event across restarted runs and preserves discrepancy history after resolution', async () => {
    const payment = { id: paymentId, walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), status: 'CAPTURED', capturedAmountMinor: 10_000, refundedAmountMinor: 0, currency: 'USD', updatedAt: '2026-01-01T01:00:00Z', operations: [{ id: operationId, type: 'CAPTURE' as const, status: 'SUCCEEDED' as const, amountMinor: 10_000, currency: 'USD', externalPaymentId: crypto.randomUUID() }] };
    const candidate = { payment, operation: payment.operations[0]!, item: statement.items[0]! };
    const firstRun = await store.createRun({ provider: statement.provider, batchId, windowStart: statement.windowStart, windowEnd: statement.windowEnd, sourceDigest: '1'.repeat(64) });
    await store.acquireRunLease(firstRun.runId, 'worker-a');
    await store.persistResult(firstRun.runId, batchId, { matched: 1, discrepancies: [], settlementCandidates: [candidate] }, crypto.randomUUID());
    const secondRun = await store.createRun({ provider: statement.provider, batchId, windowStart: statement.windowStart, windowEnd: statement.windowEnd, sourceDigest: '2'.repeat(64) });
    await store.acquireRunLease(secondRun.runId, 'worker-b');
    await store.persistResult(secondRun.runId, batchId, { matched: 1, discrepancies: [], settlementCandidates: [candidate] }, crypto.randomUUID());
    const outbox = await connection<{ count: number }[]>`SELECT COUNT(*)::int count FROM outbox_events WHERE payload->>'eventType' = 'settlement.created.v1'`;
    expect(outbox[0]?.count).toBe(1);

    const discrepancy = { fingerprint: 'a'.repeat(64), paymentId, providerTransactionId: operationId, settlementItemId: null, type: 'LEDGER_ENTRY_MISSING' as const, severity: 'WARNING' as const, repairClassification: 'SAFE_AUTO_REPAIR' as const, expected: { amountMinor: 10_000 }, actual: { journal: 'MISSING' } };
    const thirdRun = await store.createRun({ provider: statement.provider, batchId, windowStart: statement.windowStart, windowEnd: statement.windowEnd, sourceDigest: '3'.repeat(64) });
    await store.acquireRunLease(thirdRun.runId, 'worker-c');
    await store.persistResult(thirdRun.runId, batchId, { matched: 0, discrepancies: [discrepancy], settlementCandidates: [] } satisfies ReconciliationResult, crypto.randomUUID());
    const [row] = await connection<{ id: string }[]>`SELECT id FROM reconciliation_discrepancies WHERE fingerprint = ${discrepancy.fingerprint}`;
    await store.review({ discrepancyId: row!.id, action: 'RESOLVE', actor: 'integration-test', note: 'verified', correlationId: crypto.randomUUID() });
    const fourthRun = await store.createRun({ provider: statement.provider, batchId, windowStart: statement.windowStart, windowEnd: statement.windowEnd, sourceDigest: '4'.repeat(64) });
    await store.acquireRunLease(fourthRun.runId, 'worker-d');
    await store.persistResult(fourthRun.runId, batchId, { matched: 0, discrepancies: [discrepancy], settlementCandidates: [] }, crypto.randomUUID());
    const history = await connection<{ status: string; observation_count: number; observations: number }[]>`SELECT d.status, d.observation_count, COUNT(o.id)::int observations FROM reconciliation_discrepancies d JOIN discrepancy_observations o ON o.discrepancy_id = d.id WHERE d.id = ${row!.id} GROUP BY d.id`;
    expect(history[0]).toEqual({ status: 'OPEN', observation_count: 2, observations: 2 });
  });
});
