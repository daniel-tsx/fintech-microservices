import { createEvent, eventTypes, paymentEventsTopic, type EventEnvelope, type PaymentStatus } from '@ledgerflow/contracts';
import { and, asc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import { paymentOperations, paymentStateHistory, payments, idempotencyKeys, outboxEvents, webhookEvents } from './database.schema.js';
import type { PaymentDatabase } from './database.js';
import {
  IdempotencyMismatchError,
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentOperationNotFoundError,
  type Payment,
  type PaymentOperation,
  type PaymentRepository,
  type PspResult,
  type ResolutionSource,
  type WebhookEnvelope,
} from './payment.domain.js';
import { assertPaymentTransition, canTransition } from './payment-state-machine.js';

export interface PaymentTransactionProbe { afterPaymentInsert?(): Promise<void> }
type PaymentRow = typeof payments.$inferSelect;
type OperationRow = typeof paymentOperations.$inferSelect;
type PaymentTransaction = Parameters<Parameters<PaymentDatabase['transaction']>[0]>[0];

function toPayment(row: PaymentRow): Payment {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toOperation(row: OperationRow): PaymentOperation {
  return {
    id: row.id,
    paymentId: row.paymentId,
    type: row.operationType,
    amountMinor: row.amountMinor,
    currency: row.currency,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    status: row.status,
    attemptCount: row.attemptCount,
    externalPaymentId: row.externalPaymentId,
    providerSequence: row.providerSequence,
    failureCode: row.failureCode,
    resolutionSource: row.resolutionSource,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function outboxValue(event: EventEnvelope) {
  return { id: event.eventId, topic: paymentEventsTopic, aggregateId: event.aggregateId, payload: event };
}

function operationTarget(operation: PaymentOperation, result: PspResult, payment: Payment): { status: PaymentStatus; patch: Partial<Payment>; eventType: Parameters<typeof createEvent>[0]['eventType'] } {
  if (result.outcome === 'UNKNOWN') {
    if (operation.type === 'AUTHORIZE') return { status: 'AUTHORIZATION_UNKNOWN', patch: { failureCode: result.code }, eventType: eventTypes.paymentAuthorizationUnknown };
    if (operation.type === 'CAPTURE') return { status: 'CAPTURE_UNKNOWN', patch: { failureCode: result.code }, eventType: eventTypes.paymentCaptureUnknown };
    return { status: 'REFUND_UNKNOWN', patch: { failureCode: result.code }, eventType: eventTypes.paymentRefundUnknown };
  }
  if (result.outcome === 'FAILED') {
    if (operation.type === 'AUTHORIZE') return { status: 'AUTHORIZATION_FAILED', patch: { failureCode: result.code }, eventType: eventTypes.paymentAuthorizationFailed };
    if (operation.type === 'CAPTURE') return { status: 'CAPTURE_FAILED', patch: { failureCode: result.code }, eventType: eventTypes.paymentCaptureFailed };
    return { status: 'REFUND_FAILED', patch: { failureCode: result.code }, eventType: eventTypes.paymentRefundFailed };
  }
  if (result.outcome === 'DECLINED') {
    if (operation.type === 'AUTHORIZE') return { status: 'AUTHORIZATION_DECLINED', patch: { failureCode: result.code, externalPaymentId: result.externalPaymentId, providerSequence: result.providerSequence }, eventType: eventTypes.paymentAuthorizationDeclined };
    if (operation.type === 'CAPTURE') return { status: 'CAPTURE_FAILED', patch: { failureCode: result.code, providerSequence: result.providerSequence }, eventType: eventTypes.paymentCaptureFailed };
    return { status: 'REFUND_FAILED', patch: { failureCode: result.code, providerSequence: result.providerSequence }, eventType: eventTypes.paymentRefundFailed };
  }
  if (operation.type === 'AUTHORIZE') {
    return { status: 'AUTHORIZED', patch: { authorizedAmountMinor: operation.amountMinor, externalPaymentId: result.externalPaymentId, providerSequence: result.providerSequence, failureCode: null }, eventType: eventTypes.paymentAuthorized };
  }
  if (operation.type === 'CAPTURE') {
    return { status: 'CAPTURED', patch: { authorizedAmountMinor: Math.max(payment.authorizedAmountMinor, operation.amountMinor), capturedAmountMinor: operation.amountMinor, externalPaymentId: result.externalPaymentId, providerSequence: result.providerSequence, failureCode: null }, eventType: eventTypes.paymentCaptured };
  }
  const refundedAmountMinor = payment.refundedAmountMinor + operation.amountMinor;
  return {
    status: refundedAmountMinor === payment.capturedAmountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    patch: { refundedAmountMinor, providerSequence: result.providerSequence, failureCode: null },
    eventType: eventTypes.paymentRefunded,
  };
}

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly db: PaymentDatabase, private readonly probe: PaymentTransactionProbe = {}) {}

  async create(payment: Payment, key: string, requestHash: string, event: EventEnvelope): Promise<Payment> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.insert(payments).values({ ...payment, createdAt: new Date(payment.createdAt), updatedAt: new Date(payment.updatedAt) });
        await this.probe.afterPaymentInsert?.();
        await tx.insert(idempotencyKeys).values({ key, requestHash, paymentId: payment.id });
        await tx.insert(paymentStateHistory).values({ id: crypto.randomUUID(), paymentId: payment.id, previousStatus: null, nextStatus: payment.status, source: 'API_CREATE' });
        await tx.insert(outboxEvents).values(outboxValue(event));
        return payment;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await this.findIdempotentResponse(key, requestHash);
      if (replay !== null) return replay;
      throw error;
    }
  }

  async findById(id: string): Promise<Payment | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.id, id)).limit(1);
    return row === undefined ? null : toPayment(row);
  }

  async findIdempotentResponse(key: string, requestHash: string): Promise<Payment | null> {
    const [row] = await this.db.select({ idempotency: idempotencyKeys, payment: payments }).from(idempotencyKeys)
      .innerJoin(payments, eq(idempotencyKeys.paymentId, payments.id)).where(eq(idempotencyKeys.key, key)).limit(1);
    if (row === undefined) return null;
    if (row.idempotency.requestHash !== requestHash) throw new IdempotencyMismatchError('key reused with another payload');
    return toPayment(row.payment);
  }

  async transition(input: { paymentId: string; expectedStatuses: PaymentStatus[]; patch: Partial<Payment>; event?: EventEnvelope; source: string; operationId?: string }): Promise<Payment> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockPayment(tx, input.paymentId);
      if (!input.expectedStatuses.includes(current.status)) throw new PaymentConflictError(`cannot transition payment from ${current.status}`);
      const nextStatus = input.patch.status ?? current.status;
      if (nextStatus !== current.status) assertPaymentTransition(current.status, nextStatus);
      const updated = await this.updatePayment(tx, current, input.patch);
      if (nextStatus !== current.status) await this.recordHistory(tx, current, nextStatus, input.source, input.operationId, input.patch.failureCode);
      if (input.event !== undefined) await tx.insert(outboxEvents).values(outboxValue(input.event));
      return updated;
    });
  }

  async findOperationByIdempotencyKey(key: string, requestHash: string): Promise<PaymentOperation | null> {
    const [row] = await this.db.select().from(paymentOperations).where(eq(paymentOperations.idempotencyKey, key)).limit(1);
    if (row === undefined) return null;
    if (row.requestHash !== requestHash) throw new IdempotencyMismatchError('operation idempotency key reused with another payload');
    return toOperation(row);
  }

  async findOperationById(id: string): Promise<PaymentOperation | null> {
    const [row] = await this.db.select().from(paymentOperations).where(eq(paymentOperations.id, id)).limit(1);
    return row === undefined ? null : toOperation(row);
  }

  async beginOperation(input: { operation: PaymentOperation; expectedStatuses: PaymentStatus[]; pendingStatus: PaymentStatus; event?: EventEnvelope }): Promise<{ payment: Payment; operation: PaymentOperation; created: boolean }> {
    try {
      return await this.db.transaction(async (tx) => {
        const existingRows = await tx.select().from(paymentOperations).where(eq(paymentOperations.idempotencyKey, input.operation.idempotencyKey)).limit(1);
        const existing = existingRows[0];
        if (existing !== undefined) {
          if (existing.requestHash !== input.operation.requestHash) throw new IdempotencyMismatchError('operation idempotency key reused with another payload');
          return { payment: await this.lockPayment(tx, existing.paymentId), operation: toOperation(existing), created: false };
        }
        const current = await this.lockPayment(tx, input.operation.paymentId);
        if (!input.expectedStatuses.includes(current.status)) throw new PaymentConflictError(`cannot start ${input.operation.type} from ${current.status}`);
        assertPaymentTransition(current.status, input.pendingStatus);
        await tx.insert(paymentOperations).values({
          ...input.operation,
          operationType: input.operation.type,
          lastAttemptAt: null,
          resolvedAt: null,
          createdAt: new Date(input.operation.createdAt),
          updatedAt: new Date(input.operation.updatedAt),
        });
        const payment = await this.updatePayment(tx, current, { status: input.pendingStatus, failureCode: null });
        await this.recordHistory(tx, current, input.pendingStatus, 'OPERATION_STARTED', input.operation.id);
        if (input.event !== undefined) await tx.insert(outboxEvents).values(outboxValue(input.event));
        return { payment, operation: input.operation, created: true };
      });
    } catch (error) {
      if (!(isUniqueViolation(error))) throw error;
      const operation = await this.findOperationByIdempotencyKey(input.operation.idempotencyKey, input.operation.requestHash);
      if (operation === null) throw error;
      const payment = await this.findById(operation.paymentId);
      if (payment === null) throw new PaymentNotFoundError(`payment ${operation.paymentId} not found`);
      return { payment, operation, created: false };
    }
  }

  async recordOperationAttempt(operationId: string): Promise<void> {
    await this.db.update(paymentOperations).set({ attemptCount: sql`${paymentOperations.attemptCount} + 1`, lastAttemptAt: new Date(), updatedAt: new Date() }).where(eq(paymentOperations.id, operationId));
  }

  async restartFailedOperation(operationId: string, expectedStatus: PaymentStatus, pendingStatus: PaymentStatus): Promise<PaymentOperation> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)).for('update').limit(1);
      if (row === undefined) throw new PaymentOperationNotFoundError(`payment operation ${operationId} not found`);
      if (row.status !== 'FAILED') return toOperation(row);
      const current = await this.lockPayment(tx, row.paymentId);
      if (current.status !== expectedStatus) throw new PaymentConflictError(`cannot retry ${row.operationType} from ${current.status}`);
      assertPaymentTransition(current.status, pendingStatus);
      const now = new Date();
      const [operation] = await tx.update(paymentOperations).set({ status: 'PENDING', failureCode: null, resolutionSource: null, resolvedAt: null, updatedAt: now })
        .where(eq(paymentOperations.id, operationId)).returning();
      await this.updatePayment(tx, current, { status: pendingStatus, failureCode: null });
      await this.recordHistory(tx, current, pendingStatus, 'OPERATION_RETRY', operationId);
      if (operation === undefined) throw new PaymentOperationNotFoundError(`payment operation ${operationId} disappeared during retry`);
      return toOperation(operation);
    });
  }

  async resolveOperation(input: { operationId: string; result: PspResult; source: ResolutionSource; correlationId: string }): Promise<Payment> {
    return this.db.transaction((tx) => this.resolveInTransaction(tx, input.operationId, input.result, input.source, input.correlationId));
  }

  async ingestWebhook(input: WebhookEnvelope): Promise<'ACCEPTED' | 'DUPLICATE'> {
    const claimed = await this.db.insert(webhookEvents).values({
      eventId: input.eventId,
      eventType: input.eventType,
      operationId: input.operationId,
      paymentId: input.paymentId,
      providerSequence: input.providerSequence,
      payload: input,
    }).onConflictDoNothing().returning({ eventId: webhookEvents.eventId });
    return claimed.length === 0 ? 'DUPLICATE' : 'ACCEPTED';
  }

  async claimWebhookBatch(workerId: string, limit: number, leaseMilliseconds: number): Promise<WebhookEnvelope[]> {
    const result = await this.db.execute(sql`
      WITH candidates AS (
        SELECT event_id FROM webhook_events
        WHERE processing_status = 'PENDING'
          AND (locked_at IS NULL OR locked_at < now() - (${leaseMilliseconds} * interval '1 millisecond'))
        ORDER BY received_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE webhook_events AS event
      SET locked_at = now(), locked_by = ${workerId}
      FROM candidates
      WHERE event.event_id = candidates.event_id
      RETURNING event.payload
    `);
    return Array.from(result as unknown as Array<{ payload: WebhookEnvelope }>).map((row) => row.payload);
  }

  async processWebhook(workerId: string, webhook: WebhookEnvelope, correlationId: string): Promise<'PROCESSED' | 'IGNORED'> {
    return this.db.transaction(async (tx) => {
      const [eventRow] = await tx.select().from(webhookEvents).where(and(eq(webhookEvents.eventId, webhook.eventId), eq(webhookEvents.lockedBy, workerId))).for('update').limit(1);
      if (eventRow === undefined || eventRow.processingStatus !== 'PENDING') return 'IGNORED';
      const operationRows = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, webhook.operationId)).for('update').limit(1);
      const operationRow = operationRows[0];
      if (operationRow === undefined) {
        await tx.update(webhookEvents).set({ processingStatus: 'IGNORED', processedAt: new Date(), lockedAt: null, lockedBy: null, lastError: 'unknown operation' }).where(eq(webhookEvents.eventId, webhook.eventId));
        return 'IGNORED';
      }
      const expectedEventType = operationRow.operationType === 'AUTHORIZE' ? 'AUTHORIZED' : operationRow.operationType === 'CAPTURE' ? 'CAPTURED' : 'REFUNDED';
      const envelopeMismatch = operationRow.paymentId !== webhook.paymentId
        || operationRow.operationType !== webhook.operationType
        || operationRow.amountMinor !== webhook.amountMinor
        || operationRow.currency !== webhook.currency
        || (webhook.eventType !== expectedEventType && webhook.eventType !== 'DECLINED');
      if (envelopeMismatch) {
        await tx.update(webhookEvents).set({ processingStatus: 'IGNORED', processedAt: new Date(), lockedAt: null, lockedBy: null, lastError: 'webhook does not match payment operation' }).where(eq(webhookEvents.eventId, webhook.eventId));
        return 'IGNORED';
      }
      const payment = await this.lockPayment(tx, webhook.paymentId);
      if (webhook.providerSequence <= payment.providerSequence) {
        await tx.update(webhookEvents).set({ processingStatus: 'IGNORED', processedAt: new Date(), lockedAt: null, lockedBy: null, lastError: 'stale provider sequence' }).where(eq(webhookEvents.eventId, webhook.eventId));
        return 'IGNORED';
      }
      const result: PspResult = webhook.eventType === 'DECLINED'
        ? { outcome: 'DECLINED', code: 'PSP_DECLINED', externalPaymentId: webhook.externalPaymentId, providerSequence: webhook.providerSequence }
        : { outcome: 'SUCCEEDED', externalPaymentId: webhook.externalPaymentId, providerSequence: webhook.providerSequence };
      await this.resolveInTransaction(tx, webhook.operationId, result, 'WEBHOOK', correlationId, webhook.eventId);
      await tx.update(webhookEvents).set({ processingStatus: 'PROCESSED', processedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null }).where(eq(webhookEvents.eventId, webhook.eventId));
      return 'PROCESSED';
    });
  }

  async rescheduleWebhook(workerId: string, eventId: string, error: string): Promise<void> {
    await this.db.update(webhookEvents).set({ attemptCount: sql`${webhookEvents.attemptCount} + 1`, lockedAt: null, lockedBy: null, lastError: error })
      .where(and(eq(webhookEvents.eventId, eventId), eq(webhookEvents.lockedBy, workerId)));
  }

  async findRecoverableOperations(olderThan: Date, limit: number): Promise<PaymentOperation[]> {
    const rows = await this.db.select().from(paymentOperations)
      .where(and(inArray(paymentOperations.status, ['PENDING', 'UNKNOWN']), lt(paymentOperations.updatedAt, olderThan)))
      .orderBy(paymentOperations.updatedAt).limit(limit);
    return rows.map(toOperation);
  }

  async listForReconciliation(windowStart: Date, windowEnd: Date, afterId: string | undefined, limit: number): Promise<Array<Payment & { operations: PaymentOperation[] }>> {
    const conditions = [gte(payments.updatedAt, windowStart), lt(payments.updatedAt, windowEnd)];
    if (afterId !== undefined) conditions.push(gt(payments.id, afterId));
    const paymentRows = await this.db.select().from(payments).where(and(...conditions)).orderBy(asc(payments.id)).limit(limit);
    if (paymentRows.length === 0) return [];
    const operationRows = await this.db.select().from(paymentOperations).where(inArray(paymentOperations.paymentId, paymentRows.map((row) => row.id))).orderBy(asc(paymentOperations.id));
    const operationsByPayment = new Map<string, PaymentOperation[]>();
    for (const row of operationRows) operationsByPayment.set(row.paymentId, [...(operationsByPayment.get(row.paymentId) ?? []), toOperation(row)]);
    return paymentRows.map((row) => ({ ...toPayment(row), operations: operationsByPayment.get(row.id) ?? [] }));
  }

  private async resolveInTransaction(tx: PaymentTransaction, operationId: string, result: PspResult, source: ResolutionSource, correlationId: string, causationId?: string): Promise<Payment> {
    const [operationRow] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)).for('update').limit(1);
    if (operationRow === undefined) throw new PaymentOperationNotFoundError(`payment operation ${operationId} not found`);
    const operation = toOperation(operationRow);
    const current = await this.lockPayment(tx, operation.paymentId);
    if (['SUCCEEDED', 'DECLINED'].includes(operation.status)) return current;
    if ('providerSequence' in result && result.providerSequence <= current.providerSequence) {
      await tx.update(paymentOperations).set({
        status: result.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'DECLINED',
        externalPaymentId: result.externalPaymentId,
        providerSequence: result.providerSequence,
        failureCode: result.outcome === 'DECLINED' ? result.code : null,
        resolutionSource: source,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(paymentOperations.id, operationId));
      return current;
    }
    const target = operationTarget(operation, result, current);
    if (!canTransition(current.status, target.status)) {
      if (current.status === target.status) return current;
      throw new PaymentConflictError(`cannot resolve ${operation.type} from ${current.status} to ${target.status}`);
    }
    const operationStatus = result.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : result.outcome === 'DECLINED' ? 'DECLINED' : result.outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN';
    await tx.update(paymentOperations).set({
      status: operationStatus,
      ...('externalPaymentId' in result ? { externalPaymentId: result.externalPaymentId } : {}),
      ...('providerSequence' in result ? { providerSequence: result.providerSequence } : {}),
      failureCode: 'code' in result ? result.code : null,
      resolutionSource: source,
      ...(operationStatus === 'UNKNOWN' ? {} : { resolvedAt: new Date() }),
      updatedAt: new Date(),
    }).where(eq(paymentOperations.id, operationId));
    const updated = await this.updatePayment(tx, current, { ...target.patch, status: target.status });
    await this.recordHistory(tx, current, target.status, source, operation.id, 'code' in result ? result.code : undefined);
    const payload = target.eventType === eventTypes.paymentRefunded
      ? { paymentId: current.id, refundId: operation.id, walletId: current.walletId, merchantId: current.merchantId, status: target.status, amountMinor: operation.amountMinor, currency: current.currency }
      : { paymentId: current.id, walletId: current.walletId, merchantId: current.merchantId, status: target.status, amountMinor: current.amountMinor, currency: current.currency };
    const event = createEvent({ eventType: target.eventType, aggregateId: current.id, correlationId, ...(causationId === undefined ? {} : { causationId }), payload });
    await tx.insert(outboxEvents).values(outboxValue(event));
    return updated;
  }

  private async lockPayment(tx: PaymentTransaction, paymentId: string): Promise<Payment> {
    const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update').limit(1);
    if (row === undefined) throw new PaymentNotFoundError(`payment ${paymentId} not found`);
    return toPayment(row);
  }

  private async updatePayment(tx: PaymentTransaction, current: Payment, patch: Partial<Payment>): Promise<Payment> {
    const [row] = await tx.update(payments).set({
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.authorizedAmountMinor === undefined ? {} : { authorizedAmountMinor: patch.authorizedAmountMinor }),
      ...(patch.capturedAmountMinor === undefined ? {} : { capturedAmountMinor: patch.capturedAmountMinor }),
      ...(patch.refundedAmountMinor === undefined ? {} : { refundedAmountMinor: patch.refundedAmountMinor }),
      ...(patch.externalPaymentId === undefined ? {} : { externalPaymentId: patch.externalPaymentId }),
      ...(patch.providerSequence === undefined ? {} : { providerSequence: patch.providerSequence }),
      ...(patch.failureCode === undefined ? {} : { failureCode: patch.failureCode }),
      updatedAt: new Date(),
      version: sql`${payments.version} + 1`,
    }).where(and(eq(payments.id, current.id), eq(payments.version, current.version))).returning();
    if (row === undefined) throw new PaymentConflictError('payment changed concurrently');
    return toPayment(row);
  }

  private async recordHistory(tx: PaymentTransaction, current: Payment, nextStatus: PaymentStatus, source: string, operationId?: string, reason?: string | null): Promise<void> {
    await tx.insert(paymentStateHistory).values({
      id: crypto.randomUUID(),
      paymentId: current.id,
      previousStatus: current.status,
      nextStatus,
      source,
      ...(operationId === undefined ? {} : { operationId }),
      ...(reason === undefined || reason === null ? {} : { reason }),
    });
  }
}
