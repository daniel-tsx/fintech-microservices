import { createEvent, eventTypes, repairEventsTopic, settlementEventsTopic, type EventEnvelope } from '@ledgerflow/contracts';
import { canonicalJson, sha256, type OutboxStore, type PendingOutboxRecord } from '@ledgerflow/platform';
import type { ProviderSettlementStatement } from '../../psp-simulator/src/settlement-statement.js';
import type { ReconciliationDatabase, ReconciliationJson, ReconciliationTransaction } from './database.js';
import type { ReconciliationDiscrepancy, ReconciliationResult } from './reconciliation.service.js';

interface BatchRow { id: string; provider_settlement_id: string; statement_digest: string; status: string; }
interface RunRow { id: string; run_key: string; status: string; lease_owner: string | null; lease_expires_at: Date | null; }
interface DiscrepancyRow { id: string; discrepancy_type: string; repair_classification: string; payment_id: string | null; status: string; expected: Record<string, unknown> | null; actual: Record<string, unknown> | null; }

export class StatementConflictError extends Error {}
export class UnsafeRepairError extends Error {}
export class RunLeaseUnavailableError extends Error {}

function toJson(value: unknown): ReconciliationJson {
  return JSON.parse(JSON.stringify(value)) as ReconciliationJson;
}

export class ReconciliationStore {
  constructor(private readonly db: ReconciliationDatabase) {}

  async ingestStatement(statement: ProviderSettlementStatement, signatureVerified: boolean, integrityErrors: string[]): Promise<{ batchId: string; duplicate: boolean }> {
    const statementDigest = await sha256({ ...statement, signature: undefined });
    return this.db.begin(async (tx) => {
      const existing = await tx<BatchRow[]>`SELECT id, provider_settlement_id, statement_digest, status FROM settlement_batches WHERE provider = ${statement.provider} AND provider_settlement_id = ${statement.providerSettlementId} FOR UPDATE`;
      const prior = existing[0];
      if (prior !== undefined) {
        if (prior.statement_digest !== statementDigest) throw new StatementConflictError('provider settlement ID was reused with different statement content');
        return { batchId: prior.id, duplicate: true };
      }
      const batchId = crypto.randomUUID();
      await tx`INSERT INTO settlement_batches (
        id, provider, provider_settlement_id, statement_digest, statement_signature, window_start, window_end,
        currency, status, item_count, gross_total_minor, fee_total_minor, net_total_minor, signature_verified, integrity_errors
      ) VALUES (
        ${batchId}, ${statement.provider}, ${statement.providerSettlementId}, ${statementDigest}, ${statement.signature},
        ${new Date(statement.windowStart)}, ${new Date(statement.windowEnd)}, ${statement.currency},
        ${signatureVerified && integrityErrors.length === 0 ? 'CREATED' : 'REQUIRES_REVIEW'}, ${statement.itemCount},
        ${statement.grossTotalMinor}, ${statement.feeTotalMinor}, ${statement.netTotalMinor}, ${signatureVerified}, ${tx.json(integrityErrors)}
      )`;
      for (const item of statement.items) {
        const valid = item.providerItemId.length > 0 && item.providerTransactionId.length > 0
          && /^[A-Z]{3}$/.test(item.currency) && item.currency === statement.currency && item.settlementBatchId === statement.providerSettlementId
          && Number.isSafeInteger(item.grossAmountMinor) && item.grossAmountMinor > 0
          && Number.isSafeInteger(item.feeAmountMinor) && item.feeAmountMinor >= 0 && Number.isSafeInteger(item.netAmountMinor);
        await tx`INSERT INTO settlement_items (
          id, batch_id, provider_item_id, provider_transaction_id, payment_id, operation_id, operation_type,
          gross_amount_minor, fee_amount_minor, net_amount_minor, currency, provider_status, status, last_error
        ) VALUES (
          ${crypto.randomUUID()}, ${batchId}, ${item.providerItemId}, ${item.providerTransactionId},
          ${item.merchantReference}, ${item.operationId}, ${item.operationType}, ${item.grossAmountMinor},
          ${item.feeAmountMinor}, ${item.netAmountMinor}, ${item.currency}, ${item.providerStatus},
          ${valid ? 'PENDING' : 'MALFORMED'}, ${valid ? null : 'statement item failed structural validation'}
        )`;
      }
      return { batchId, duplicate: false };
    });
  }

  async createRun(input: { provider: string; batchId: string; windowStart: string; windowEnd: string; sourceDigest: string }): Promise<{ runId: string; duplicate: boolean; status: string }> {
    const runKey = await sha256({ provider: input.provider, batchId: input.batchId, windowStart: input.windowStart, windowEnd: input.windowEnd, sourceDigest: input.sourceDigest });
    const id = crypto.randomUUID();
    const rows = await this.db<RunRow[]>`
      INSERT INTO reconciliation_runs (id, run_key, provider, settlement_batch_id, source_digest, window_start, window_end, status)
      VALUES (${id}, ${runKey}, ${input.provider}, ${input.batchId}, ${input.sourceDigest}, ${new Date(input.windowStart)}, ${new Date(input.windowEnd)}, 'CREATED')
      ON CONFLICT (run_key) DO NOTHING
      RETURNING id, run_key, status, lease_owner, lease_expires_at
    `;
    if (rows[0] !== undefined) return { runId: rows[0].id, duplicate: false, status: rows[0].status };
    const existing = await this.db<RunRow[]>`SELECT id, run_key, status, lease_owner, lease_expires_at FROM reconciliation_runs WHERE run_key = ${runKey}`;
    if (existing[0] === undefined) throw new Error('reconciliation run upsert did not return a row');
    return { runId: existing[0].id, duplicate: true, status: existing[0].status };
  }

  async acquireRunLease(runId: string, workerId: string, leaseMilliseconds = 30_000): Promise<void> {
    const rows = await this.db<RunRow[]>`
      UPDATE reconciliation_runs SET status = 'RUNNING', lease_owner = ${workerId},
        lease_expires_at = now() + (${leaseMilliseconds} * interval '1 millisecond'), started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = ${runId} AND status IN ('CREATED','RUNNING','PARTIALLY_COMPLETED')
        AND (lease_owner IS NULL OR lease_owner = ${workerId} OR lease_expires_at < now())
      RETURNING id, run_key, status, lease_owner, lease_expires_at
    `;
    if (rows.length === 0) throw new RunLeaseUnavailableError('another worker owns this reconciliation run');
  }

  async persistResult(runId: string, batchId: string, result: ReconciliationResult, correlationId: string): Promise<void> {
    for (const discrepancy of result.discrepancies) {
      await this.db.begin(async (tx) => {
        await this.persistDiscrepancy(tx, runId, batchId, discrepancy);
        await tx`UPDATE reconciliation_runs SET checkpoint = ${discrepancy.fingerprint}, updated_at = now() WHERE id = ${runId}`;
      });
    }
    for (const candidate of result.settlementCandidates) {
      await this.db.begin(async (tx) => {
        const itemRows = await tx<{ id: string; status: string }[]>`SELECT id, status FROM settlement_items WHERE batch_id = ${batchId} AND provider_item_id = ${candidate.item.providerItemId} FOR UPDATE`;
        const itemRow = itemRows[0];
        if (itemRow === undefined || !['PENDING','MATCHED'].includes(itemRow.status)) return;
        const event = createEvent({
          eventType: eventTypes.settlementCreated,
          aggregateId: itemRow.id,
          correlationId,
          payload: {
            settlementBatchId: batchId, settlementItemId: itemRow.id,
            providerSettlementId: candidate.item.settlementBatchId,
            providerTransactionId: candidate.item.providerTransactionId,
            paymentId: candidate.payment.id, operationId: candidate.operation.id,
            operationType: candidate.operation.type, grossAmountMinor: candidate.item.grossAmountMinor,
            feeAmountMinor: candidate.item.feeAmountMinor, netAmountMinor: candidate.item.netAmountMinor,
            currency: candidate.item.currency,
          },
        });
        await tx`UPDATE settlement_items SET status = 'POSTING', updated_at = now() WHERE id = ${itemRow.id}`;
        await this.insertOutbox(tx, event, settlementEventsTopic);
        const evidenceDigest = await sha256({ paymentId: candidate.payment.id, operationId: candidate.operation.id, providerItemId: candidate.item.providerItemId });
        await tx`INSERT INTO reconciliation_items (id, run_id, item_key, payment_id, provider_transaction_id, settlement_item_id, result, evidence_digest)
          VALUES (${crypto.randomUUID()}, ${runId}, ${candidate.item.providerItemId}, ${candidate.payment.id}, ${candidate.item.providerTransactionId}, ${itemRow.id}, 'MATCHED', ${evidenceDigest})
          ON CONFLICT (run_id, item_key) DO NOTHING`;
        await tx`UPDATE reconciliation_runs SET checkpoint = ${candidate.item.providerItemId}, updated_at = now() WHERE id = ${runId}`;
      });
    }
    await this.db.begin(async (tx) => {
      const mismatchCount = result.discrepancies.length;
      const autoRepairCount = result.discrepancies.filter((item) => item.repairClassification === 'SAFE_AUTO_REPAIR').length;
      await tx`UPDATE reconciliation_runs SET status = 'COMPLETED', matched_count = ${result.matched}, mismatch_count = ${mismatchCount},
        auto_repair_count = ${autoRepairCount}, manual_review_count = ${mismatchCount - autoRepairCount},
        completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = ${runId}`;
      await tx`UPDATE settlement_batches SET status = ${mismatchCount === 0 ? 'RECONCILED' : 'PARTIALLY_MATCHED'}, updated_at = now() WHERE id = ${batchId}`;
    });
  }

  async markRunFailed(runId: string, workerId: string): Promise<void> {
    await this.db`UPDATE reconciliation_runs SET status = 'PARTIALLY_COMPLETED', lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = ${runId} AND lease_owner = ${workerId}`;
  }

  async confirmLedgerSettlements(batchId: string, settlementReferenceIds: string[]): Promise<number> {
    if (settlementReferenceIds.length === 0) return 0;
    return this.db.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`UPDATE settlement_items SET status = 'SETTLED', updated_at = now()
        WHERE batch_id = ${batchId} AND id IN ${tx(settlementReferenceIds)} AND status IN ('POSTING','SETTLED') RETURNING id`;
      const counts = await tx<{ unfinished: number; review: number }[]>`SELECT
        COUNT(*) FILTER (WHERE status IN ('PENDING','MATCHED','POSTING'))::int AS unfinished,
        COUNT(*) FILTER (WHERE status IN ('MISMATCHED','MALFORMED'))::int AS review
        FROM settlement_items WHERE batch_id = ${batchId}`;
      const count = counts[0];
      if (count?.unfinished === 0) await tx`UPDATE settlement_batches SET status = ${count.review === 0 ? 'COMPLETED' : 'REQUIRES_REVIEW'}, completed_at = ${count.review === 0 ? new Date() : null}, updated_at = now() WHERE id = ${batchId}`;
      return rows.length;
    });
  }

  async getRun(id: string) {
    const rows = await this.db`SELECT * FROM reconciliation_runs WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  async listDiscrepancies(status?: string) {
    return status === undefined
      ? this.db`SELECT * FROM reconciliation_discrepancies ORDER BY last_detected_at DESC LIMIT 200`
      : this.db`SELECT * FROM reconciliation_discrepancies WHERE status = ${status} ORDER BY last_detected_at DESC LIMIT 200`;
  }

  async getDiscrepancy(id: string) {
    const rows = await this.db`SELECT d.*, COALESCE(json_agg(o ORDER BY o.observed_at) FILTER (WHERE o.id IS NOT NULL), '[]') AS observations,
      COALESCE((SELECT json_agg(r ORDER BY r.created_at) FROM repair_actions r WHERE r.discrepancy_id = d.id), '[]') AS repairs
      FROM reconciliation_discrepancies d LEFT JOIN discrepancy_observations o ON o.discrepancy_id = d.id WHERE d.id = ${id} GROUP BY d.id`;
    return rows[0] ?? null;
  }

  async review(input: { discrepancyId: string; action: 'ACKNOWLEDGE' | 'MARK_FALSE_POSITIVE' | 'ESCALATE' | 'RESOLVE'; actor: string; note: string; correlationId: string }) {
    return this.db.begin(async (tx) => {
      const rows = await tx<DiscrepancyRow[]>`SELECT d.*, o.expected, o.actual FROM reconciliation_discrepancies d
        LEFT JOIN LATERAL (SELECT expected, actual FROM discrepancy_observations WHERE discrepancy_id = d.id ORDER BY observed_at DESC LIMIT 1) o ON true
        WHERE d.id = ${input.discrepancyId} FOR UPDATE OF d`;
      const discrepancy = rows[0];
      if (discrepancy === undefined) return null;
      const nextStatus = input.action === 'ACKNOWLEDGE' ? 'ACKNOWLEDGED' : input.action === 'MARK_FALSE_POSITIVE' ? 'FALSE_POSITIVE' : input.action === 'ESCALATE' ? 'ESCALATED' : 'RESOLVED';
      const actionId = crypto.randomUUID();
      await tx`INSERT INTO repair_actions (id, discrepancy_id, action, actor, automatic, status, previous_state, resulting_state, evidence, correlation_id, completed_at)
        VALUES (${actionId}, ${input.discrepancyId}, ${input.action}, ${input.actor}, false, 'SUCCEEDED', ${tx.json({ status: discrepancy.status })}, ${tx.json({ status: nextStatus, note: input.note })}, ${tx.json(toJson({ expected: discrepancy.expected, actual: discrepancy.actual }))}, ${input.correlationId}, now())`;
      await tx`UPDATE reconciliation_discrepancies SET status = ${nextStatus}, resolution = ${input.note}, resolved_by = ${input.actor},
        resolved_at = ${['RESOLVED','FALSE_POSITIVE'].includes(nextStatus) ? new Date() : null} WHERE id = ${input.discrepancyId}`;
      return { actionId, status: nextStatus };
    });
  }

  async emitSafeLedgerRepair(discrepancyId: string, actor: string, correlationId: string) {
    return this.db.begin(async (tx) => {
      const rows = await tx<DiscrepancyRow[]>`SELECT d.*, o.expected, o.actual FROM reconciliation_discrepancies d
        LEFT JOIN LATERAL (SELECT expected, actual FROM discrepancy_observations WHERE discrepancy_id = d.id ORDER BY observed_at DESC LIMIT 1) o ON true
        WHERE d.id = ${discrepancyId} FOR UPDATE OF d`;
      const discrepancy = rows[0];
      if (discrepancy === undefined) return null;
      if (discrepancy.repair_classification !== 'SAFE_AUTO_REPAIR' || discrepancy.discrepancy_type !== 'LEDGER_ENTRY_MISSING' || discrepancy.expected === null || discrepancy.payment_id === null) {
        throw new UnsafeRepairError('this discrepancy is not eligible for automatic Ledger repair');
      }
      const expected = discrepancy.expected;
      const event = createEvent({ eventType: eventTypes.ledgerRepairRequested, aggregateId: discrepancy.payment_id, correlationId, payload: {
        discrepancyId, paymentId: discrepancy.payment_id, walletId: String(expected.walletId), merchantId: String(expected.merchantId),
        amountMinor: Number(expected.amountMinor), currency: String(expected.currency),
      } });
      const actionId = crypto.randomUUID();
      await tx`INSERT INTO repair_actions (id, discrepancy_id, action, actor, automatic, status, previous_state, resulting_state, evidence, correlation_id)
        VALUES (${actionId}, ${discrepancyId}, 'APPLY_SAFE_REPAIR', ${actor}, ${actor === 'SYSTEM'}, 'EMITTED', ${tx.json({ status: discrepancy.status })}, ${tx.json({ eventId: event.eventId })}, ${tx.json(toJson({ expected: discrepancy.expected, actual: discrepancy.actual }))}, ${correlationId})`;
      await this.insertOutbox(tx, event, repairEventsTopic);
      return { actionId, eventId: event.eventId };
    });
  }

  private async persistDiscrepancy(tx: ReconciliationTransaction, runId: string, batchId: string, discrepancy: ReconciliationDiscrepancy): Promise<void> {
    const id = crypto.randomUUID();
    const settlementItems = discrepancy.settlementItemId === null ? [] : await tx<{ id: string }[]>`SELECT id FROM settlement_items WHERE batch_id = ${batchId} AND provider_item_id = ${discrepancy.settlementItemId} LIMIT 1`;
    const settlementItemId = settlementItems[0]?.id ?? null;
    if (settlementItemId !== null) await tx`UPDATE settlement_items SET status = 'MISMATCHED', updated_at = now() WHERE id = ${settlementItemId} AND status = 'PENDING'`;
    const rows = await tx<{ id: string }[]>`INSERT INTO reconciliation_discrepancies (
      id, fingerprint, discrepancy_type, severity, repair_classification, payment_id, provider_transaction_id, settlement_item_id, status, observation_count
    ) VALUES (${id}, ${discrepancy.fingerprint}, ${discrepancy.type}, ${discrepancy.severity}, ${discrepancy.repairClassification},
      ${discrepancy.paymentId}, ${discrepancy.providerTransactionId}, ${settlementItemId}, 'OPEN', 0)
    ON CONFLICT (fingerprint) DO UPDATE SET last_detected_at = now(),
      status = CASE WHEN reconciliation_discrepancies.status IN ('RESOLVED','FALSE_POSITIVE') THEN 'OPEN' ELSE reconciliation_discrepancies.status END
    RETURNING id`;
    const discrepancyId = rows[0]?.id;
    if (discrepancyId === undefined) throw new Error('discrepancy upsert did not return an id');
    const evidenceDigest = await sha256({ expected: discrepancy.expected, actual: discrepancy.actual });
    const observation = await tx<{ id: string }[]>`INSERT INTO discrepancy_observations (id, discrepancy_id, run_id, expected, actual, evidence_digest)
      VALUES (${crypto.randomUUID()}, ${discrepancyId}, ${runId}, ${discrepancy.expected === null ? null : tx.json(toJson(discrepancy.expected))}, ${discrepancy.actual === null ? null : tx.json(toJson(discrepancy.actual))}, ${evidenceDigest})
      ON CONFLICT (discrepancy_id, run_id) DO NOTHING RETURNING id`;
    if (observation.length > 0) await tx`UPDATE reconciliation_discrepancies SET observation_count = observation_count + 1 WHERE id = ${discrepancyId}`;
    await tx`INSERT INTO reconciliation_items (id, run_id, item_key, payment_id, provider_transaction_id, settlement_item_id, result, evidence_digest)
      VALUES (${crypto.randomUUID()}, ${runId}, ${discrepancy.fingerprint}, ${discrepancy.paymentId}, ${discrepancy.providerTransactionId}, ${settlementItemId}, 'MISMATCHED', ${evidenceDigest})
      ON CONFLICT (run_id, item_key) DO NOTHING`;
  }

  private async insertOutbox(tx: ReconciliationTransaction, event: EventEnvelope, topic: string): Promise<void> {
    await tx`INSERT INTO outbox_events (id, topic, aggregate_id, payload) VALUES (${event.eventId}, ${topic}, ${event.aggregateId}, ${tx.json(toJson(event))}) ON CONFLICT (id) DO NOTHING`;
  }
}

interface ClaimedRow { id: string; topic: string; aggregate_id: string; payload: unknown; attempts: number; }
export class ReconciliationOutboxStore implements OutboxStore {
  constructor(private readonly db: ReconciliationDatabase, private readonly workerId: string, private readonly leaseMilliseconds = 30_000) {}
  async claimBatch(limit: number): Promise<PendingOutboxRecord[]> {
    const rows = await this.db<ClaimedRow[]>`WITH candidates AS (
      SELECT id FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL AND available_at <= now()
      AND (locked_at IS NULL OR locked_at < now() - (${this.leaseMilliseconds} * interval '1 millisecond'))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit})
      UPDATE outbox_events e SET locked_at = now(), locked_by = ${this.workerId} FROM candidates WHERE e.id = candidates.id
      RETURNING e.id, e.topic, e.aggregate_id, e.payload, e.attempts`;
    return rows.map((row) => ({ id: row.id, topic: row.topic, key: row.aggregate_id, payload: JSON.stringify(row.payload), attempts: row.attempts }));
  }
  async markPublished(id: string) { await this.db`UPDATE outbox_events SET published_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL WHERE id = ${id} AND locked_by = ${this.workerId}`; }
  async reschedule(id: string, availableAt: Date, error: string) { await this.db`UPDATE outbox_events SET attempts = attempts + 1, available_at = ${availableAt}, last_error = ${error}, locked_at = NULL, locked_by = NULL WHERE id = ${id} AND locked_by = ${this.workerId}`; }
  async moveToDeadLetter(record: PendingOutboxRecord, error: string) { await this.db.begin(async (tx) => { await tx`INSERT INTO dead_letter_events (event_id, payload, error) VALUES (${record.id}, ${record.payload}::jsonb, ${error}) ON CONFLICT DO NOTHING`; await tx`UPDATE outbox_events SET attempts = attempts + 1, dead_lettered_at = now(), last_error = ${error}, locked_at = NULL, locked_by = NULL WHERE id = ${record.id} AND locked_by = ${this.workerId}`; }); }
}

export function statementSourceDigest(statement: ProviderSettlementStatement): Promise<string> {
  return sha256(canonicalJson(statement));
}
