import { createEvent, eventTypes, type EventEnvelope, type PaymentStatus } from '@ledgerflow/contracts';
import { IdempotencyMismatchError, PaymentConflictError, PaymentNotFoundError, type Payment, type PaymentOperation, type PaymentRepository, type PspResult, type ResolutionSource, type WebhookEnvelope } from './payment.domain.js';
import { assertPaymentTransition, canTransition } from './payment-state-machine.js';

interface IdempotencyRecord { requestHash: string; paymentId: string }
interface StoredWebhook { payload: WebhookEnvelope; status: 'PENDING' | 'PROCESSED' | 'IGNORED'; lockedBy: string | null; receivedAt: number }

export class InMemoryPaymentRepository implements PaymentRepository {
  readonly payments = new Map<string, Payment>();
  readonly outbox: EventEnvelope[] = [];
  readonly operations = new Map<string, PaymentOperation>();
  readonly history: Array<{ paymentId: string; previousStatus: PaymentStatus | null; nextStatus: PaymentStatus; source: string; operationId?: string }> = [];
  readonly webhooks = new Map<string, StoredWebhook>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly operationKeys = new Map<string, string>();

  async create(payment: Payment, key: string, requestHash: string, event: EventEnvelope): Promise<Payment> {
    const existing = this.idempotency.get(key);
    if (existing !== undefined) { if (existing.requestHash !== requestHash) throw new IdempotencyMismatchError('key reused with another payload'); return this.requirePayment(existing.paymentId); }
    this.idempotency.set(key, { requestHash, paymentId: payment.id }); this.payments.set(payment.id, structuredClone(payment)); this.outbox.push(structuredClone(event));
    this.history.push({ paymentId: payment.id, previousStatus: null, nextStatus: payment.status, source: 'API_CREATE' });
    return structuredClone(payment);
  }

  async findById(id: string): Promise<Payment | null> { const payment = this.payments.get(id); return payment === undefined ? null : structuredClone(payment); }
  async findIdempotentResponse(key: string, requestHash: string): Promise<Payment | null> {
    const existing = this.idempotency.get(key); if (existing === undefined) return null;
    if (existing.requestHash !== requestHash) throw new IdempotencyMismatchError('key reused with another payload'); return this.requirePayment(existing.paymentId);
  }

  async transition(input: { paymentId: string; expectedStatuses: PaymentStatus[]; patch: Partial<Payment>; event?: EventEnvelope; source: string; operationId?: string }): Promise<Payment> {
    const current = this.requirePayment(input.paymentId); if (!input.expectedStatuses.includes(current.status)) throw new PaymentConflictError(`cannot transition payment from ${current.status}`);
    const nextStatus = input.patch.status ?? current.status; if (nextStatus !== current.status) assertPaymentTransition(current.status, nextStatus);
    const next = { ...current, ...input.patch, version: current.version + 1, updatedAt: new Date().toISOString() }; this.payments.set(next.id, next);
    if (nextStatus !== current.status) this.history.push({ paymentId: current.id, previousStatus: current.status, nextStatus, source: input.source, ...(input.operationId === undefined ? {} : { operationId: input.operationId }) });
    if (input.event !== undefined) this.outbox.push(structuredClone(input.event)); return structuredClone(next);
  }

  async findOperationByIdempotencyKey(key: string, requestHash: string): Promise<PaymentOperation | null> {
    const id = this.operationKeys.get(key); if (id === undefined) return null; const operation = this.operations.get(id)!;
    if (operation.requestHash !== requestHash) throw new IdempotencyMismatchError('operation idempotency key reused with another payload'); return structuredClone(operation);
  }
  async findOperationById(id: string): Promise<PaymentOperation | null> { const operation = this.operations.get(id); return operation === undefined ? null : structuredClone(operation); }

  async beginOperation(input: { operation: PaymentOperation; expectedStatuses: PaymentStatus[]; pendingStatus: PaymentStatus; event?: EventEnvelope }): Promise<{ payment: Payment; operation: PaymentOperation; created: boolean }> {
    const existing = await this.findOperationByIdempotencyKey(input.operation.idempotencyKey, input.operation.requestHash);
    if (existing !== null) return { payment: this.requirePayment(existing.paymentId), operation: existing, created: false };
    const payment = this.requirePayment(input.operation.paymentId); if (!input.expectedStatuses.includes(payment.status)) throw new PaymentConflictError(`cannot start ${input.operation.type} from ${payment.status}`);
    assertPaymentTransition(payment.status, input.pendingStatus); this.operations.set(input.operation.id, structuredClone(input.operation)); this.operationKeys.set(input.operation.idempotencyKey, input.operation.id);
    const updated = await this.transition({
      paymentId: payment.id,
      expectedStatuses: [payment.status],
      patch: { status: input.pendingStatus, failureCode: null },
      source: 'OPERATION_STARTED',
      operationId: input.operation.id,
      ...(input.event === undefined ? {} : { event: input.event }),
    });
    return { payment: updated, operation: structuredClone(input.operation), created: true };
  }

  async recordOperationAttempt(operationId: string): Promise<void> { const operation = this.operations.get(operationId); if (operation !== undefined) this.operations.set(operationId, { ...operation, attemptCount: operation.attemptCount + 1, lastAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }
  async restartFailedOperation(operationId: string, expectedStatus: PaymentStatus, pendingStatus: PaymentStatus): Promise<PaymentOperation> {
    const operation = this.operations.get(operationId); if (operation === undefined) throw new Error(`operation ${operationId} not found`); if (operation.status !== 'FAILED') return structuredClone(operation);
    const payment = this.requirePayment(operation.paymentId); if (payment.status !== expectedStatus) throw new PaymentConflictError(`cannot retry ${operation.type} from ${payment.status}`);
    assertPaymentTransition(payment.status, pendingStatus); const now = new Date().toISOString(); const restarted = { ...operation, status: 'PENDING' as const, failureCode: null, resolutionSource: null, resolvedAt: null, updatedAt: now };
    this.operations.set(operationId, restarted); await this.transition({ paymentId: payment.id, expectedStatuses: [expectedStatus], patch: { status: pendingStatus, failureCode: null }, source: 'OPERATION_RETRY', operationId }); return structuredClone(restarted);
  }
  async resolveOperation(input: { operationId: string; result: PspResult; source: ResolutionSource; correlationId: string }): Promise<Payment> { return this.resolve(input.operationId, input.result, input.source, input.correlationId); }

  async ingestWebhook(input: WebhookEnvelope): Promise<'ACCEPTED' | 'DUPLICATE'> { if (this.webhooks.has(input.eventId)) return 'DUPLICATE'; this.webhooks.set(input.eventId, { payload: structuredClone(input), status: 'PENDING', lockedBy: null, receivedAt: Date.now() }); return 'ACCEPTED'; }
  async claimWebhookBatch(workerId: string, limit: number, leaseMilliseconds?: number): Promise<WebhookEnvelope[]> { void leaseMilliseconds; const claimed: WebhookEnvelope[] = []; for (const webhook of this.webhooks.values()) { if (claimed.length >= limit) break; if (webhook.status === 'PENDING' && webhook.lockedBy === null) { webhook.lockedBy = workerId; claimed.push(structuredClone(webhook.payload)); } } return claimed; }
  async processWebhook(workerId: string, webhook: WebhookEnvelope, correlationId: string): Promise<'PROCESSED' | 'IGNORED'> {
    const stored = this.webhooks.get(webhook.eventId); if (stored === undefined || stored.lockedBy !== workerId || stored.status !== 'PENDING') return 'IGNORED';
    const operation = this.operations.get(webhook.operationId);
    const expectedEventType = operation?.type === 'AUTHORIZE' ? 'AUTHORIZED' : operation?.type === 'CAPTURE' ? 'CAPTURED' : 'REFUNDED';
    if (operation === undefined || operation.paymentId !== webhook.paymentId || operation.type !== webhook.operationType || operation.amountMinor !== webhook.amountMinor || operation.currency !== webhook.currency || (webhook.eventType !== expectedEventType && webhook.eventType !== 'DECLINED')) { stored.status = 'IGNORED'; stored.lockedBy = null; return 'IGNORED'; }
    const payment = this.requirePayment(webhook.paymentId); if (webhook.providerSequence <= payment.providerSequence) { stored.status = 'IGNORED'; stored.lockedBy = null; return 'IGNORED'; }
    const result: PspResult = webhook.eventType === 'DECLINED' ? { outcome: 'DECLINED', code: 'PSP_DECLINED', externalPaymentId: webhook.externalPaymentId, providerSequence: webhook.providerSequence } : { outcome: 'SUCCEEDED', externalPaymentId: webhook.externalPaymentId, providerSequence: webhook.providerSequence };
    await this.resolve(webhook.operationId, result, 'WEBHOOK', correlationId, webhook.eventId); stored.status = 'PROCESSED'; stored.lockedBy = null; return 'PROCESSED';
  }
  async rescheduleWebhook(workerId: string, eventId: string): Promise<void> { const stored = this.webhooks.get(eventId); if (stored?.lockedBy === workerId) stored.lockedBy = null; }
  async findRecoverableOperations(olderThan: Date, limit: number): Promise<PaymentOperation[]> { return Array.from(this.operations.values()).filter((operation) => ['PENDING', 'UNKNOWN'].includes(operation.status) && new Date(operation.updatedAt) < olderThan).slice(0, limit).map((operation) => structuredClone(operation)); }
  async listForReconciliation(windowStart: Date, windowEnd: Date, afterId: string | undefined, limit: number): Promise<Array<Payment & { operations: PaymentOperation[] }>> {
    return Array.from(this.payments.values())
      .filter((payment) => new Date(payment.updatedAt) >= windowStart && new Date(payment.updatedAt) < windowEnd && (afterId === undefined || payment.id > afterId))
      .sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit)
      .map((payment) => ({ ...structuredClone(payment), operations: Array.from(this.operations.values()).filter((operation) => operation.paymentId === payment.id).map((operation) => structuredClone(operation)) }));
  }

  private async resolve(operationId: string, result: PspResult, source: ResolutionSource, correlationId: string, causationId?: string): Promise<Payment> {
    const operation = this.operations.get(operationId); if (operation === undefined) throw new Error(`operation ${operationId} not found`); const current = this.requirePayment(operation.paymentId);
    if (['SUCCEEDED', 'DECLINED'].includes(operation.status)) return current;
    if ('providerSequence' in result && result.providerSequence <= current.providerSequence) { this.operations.set(operationId, { ...operation, status: result.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'DECLINED', externalPaymentId: result.externalPaymentId, providerSequence: result.providerSequence, resolutionSource: source, resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); return current; }
    const target = this.target(operation, result, current); if (!canTransition(current.status, target.status) && current.status !== target.status) throw new PaymentConflictError(`cannot resolve ${operation.type} from ${current.status}`);
    const operationStatus = result.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : result.outcome === 'DECLINED' ? 'DECLINED' : result.outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN';
    this.operations.set(operationId, { ...operation, status: operationStatus, ...('externalPaymentId' in result ? { externalPaymentId: result.externalPaymentId } : {}), ...('providerSequence' in result ? { providerSequence: result.providerSequence } : {}), failureCode: 'code' in result ? result.code : null, resolutionSource: source, resolvedAt: operationStatus === 'UNKNOWN' ? null : new Date().toISOString(), updatedAt: new Date().toISOString() });
    const payload = operation.type === 'REFUND' && result.outcome === 'SUCCEEDED'
      ? { paymentId: current.id, refundId: operation.id, walletId: current.walletId, merchantId: current.merchantId, status: target.status, amountMinor: operation.amountMinor, currency: current.currency }
      : { paymentId: current.id, walletId: current.walletId, merchantId: current.merchantId, status: target.status, amountMinor: current.amountMinor, currency: current.currency };
    return this.transition({ paymentId: current.id, expectedStatuses: [current.status], patch: { ...target.patch, status: target.status }, source, operationId, event: createEvent({ eventType: target.eventType, aggregateId: current.id, correlationId, ...(causationId === undefined ? {} : { causationId }), payload }) });
  }

  private target(operation: PaymentOperation, result: PspResult, payment: Payment): { status: PaymentStatus; patch: Partial<Payment>; eventType: Parameters<typeof createEvent>[0]['eventType'] } {
    if (result.outcome === 'UNKNOWN') return operation.type === 'AUTHORIZE' ? { status: 'AUTHORIZATION_UNKNOWN', patch: { failureCode: result.code }, eventType: eventTypes.paymentAuthorizationUnknown } : operation.type === 'CAPTURE' ? { status: 'CAPTURE_UNKNOWN', patch: { failureCode: result.code }, eventType: eventTypes.paymentCaptureUnknown } : { status: 'REFUND_UNKNOWN', patch: { failureCode: result.code }, eventType: eventTypes.paymentRefundUnknown };
    if (result.outcome === 'FAILED') return operation.type === 'AUTHORIZE' ? { status: 'AUTHORIZATION_FAILED', patch: { failureCode: result.code }, eventType: eventTypes.paymentAuthorizationFailed } : operation.type === 'CAPTURE' ? { status: 'CAPTURE_FAILED', patch: { failureCode: result.code }, eventType: eventTypes.paymentCaptureFailed } : { status: 'REFUND_FAILED', patch: { failureCode: result.code }, eventType: eventTypes.paymentRefundFailed };
    if (result.outcome === 'DECLINED') return operation.type === 'AUTHORIZE' ? { status: 'AUTHORIZATION_DECLINED', patch: { failureCode: result.code, externalPaymentId: result.externalPaymentId, providerSequence: result.providerSequence }, eventType: eventTypes.paymentAuthorizationDeclined } : operation.type === 'CAPTURE' ? { status: 'CAPTURE_FAILED', patch: { failureCode: result.code, providerSequence: result.providerSequence }, eventType: eventTypes.paymentCaptureFailed } : { status: 'REFUND_FAILED', patch: { failureCode: result.code, providerSequence: result.providerSequence }, eventType: eventTypes.paymentRefundFailed };
    if (operation.type === 'AUTHORIZE') return { status: 'AUTHORIZED', patch: { authorizedAmountMinor: operation.amountMinor, externalPaymentId: result.externalPaymentId, providerSequence: result.providerSequence, failureCode: null }, eventType: eventTypes.paymentAuthorized };
    if (operation.type === 'CAPTURE') return { status: 'CAPTURED', patch: { authorizedAmountMinor: Math.max(payment.authorizedAmountMinor, operation.amountMinor), capturedAmountMinor: operation.amountMinor, externalPaymentId: result.externalPaymentId, providerSequence: result.providerSequence, failureCode: null }, eventType: eventTypes.paymentCaptured };
    const refunded = payment.refundedAmountMinor + operation.amountMinor; return { status: refunded === payment.capturedAmountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED', patch: { refundedAmountMinor: refunded, providerSequence: result.providerSequence, failureCode: null }, eventType: eventTypes.paymentRefunded };
  }

  private requirePayment(id: string): Payment { const payment = this.payments.get(id); if (payment === undefined) throw new PaymentNotFoundError(`payment ${id} not found`); return structuredClone(payment); }
}
