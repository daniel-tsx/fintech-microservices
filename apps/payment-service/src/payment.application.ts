import { createEvent, eventTypes, type PaymentStatus, type PspScenario } from '@ledgerflow/contracts';
import { sha256 } from '@ledgerflow/platform';
import {
  PaymentConflictError,
  PaymentNotFoundError,
  assertMinorUnits,
  type Payment,
  type PaymentOperation,
  type PaymentOperationType,
  type PaymentRepository,
  type PspOperationInput,
  type PspPort,
  type PspResult,
  type RiskPort,
  type WebhookEnvelope,
} from './payment.domain.js';

export interface CreatePaymentCommand {
  walletId: string;
  merchantId: string;
  customerId: string;
  amountMinor: number;
  currency: string;
}

export class PaymentApplication {
  constructor(private readonly repository: PaymentRepository, private readonly risk: RiskPort, private readonly psp: PspPort) {}

  async create(command: CreatePaymentCommand, idempotencyKey: string, correlationId: string): Promise<Payment> {
    assertMinorUnits(command.amountMinor);
    const requestHash = await sha256(command);
    const existing = await this.repository.findIdempotentResponse(idempotencyKey, requestHash);
    if (existing !== null) return existing;
    const now = new Date().toISOString();
    const payment: Payment = {
      id: crypto.randomUUID(),
      walletId: command.walletId,
      merchantId: command.merchantId,
      customerId: command.customerId,
      amountMinor: command.amountMinor,
      currency: command.currency,
      status: 'RISK_PENDING',
      authorizedAmountMinor: 0,
      capturedAmountMinor: 0,
      refundedAmountMinor: 0,
      externalPaymentId: null,
      providerSequence: 0,
      failureCode: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    const event = createEvent({
      eventType: eventTypes.paymentCreated,
      aggregateId: payment.id,
      correlationId,
      payload: { paymentId: payment.id, walletId: payment.walletId, merchantId: payment.merchantId, amountMinor: payment.amountMinor, currency: payment.currency },
    });
    return this.repository.create(payment, idempotencyKey, requestHash, event);
  }

  async authorize(paymentId: string, customerId: string, correlationId: string, scenario?: PspScenario): Promise<Payment> {
    let payment = await this.requirePayment(paymentId);
    if (payment.status === 'RISK_PENDING') {
      const decision = await this.risk.evaluate({ paymentId, customerId, amountMinor: payment.amountMinor, currency: payment.currency });
      if (decision.decision === 'REJECT') {
        return this.repository.transition({
          paymentId,
          expectedStatuses: ['RISK_PENDING'],
          patch: { status: 'RISK_REJECTED', failureCode: decision.reasonCodes.join(',') },
          source: 'RISK_HTTP',
          event: createEvent({ eventType: eventTypes.riskRejected, aggregateId: paymentId, correlationId, payload: { paymentId, reasonCodes: decision.reasonCodes } }),
        });
      }
      payment = await this.repository.transition({
        paymentId,
        expectedStatuses: ['RISK_PENDING'],
        patch: { status: 'RISK_APPROVED', failureCode: null },
        source: 'RISK_HTTP',
        event: createEvent({ eventType: eventTypes.riskApproved, aggregateId: paymentId, correlationId, payload: { paymentId, reasonCodes: decision.reasonCodes } }),
      });
    }
    if (['AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURE_UNKNOWN', 'CAPTURED', 'REFUND_PENDING', 'REFUND_UNKNOWN', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(payment.status)) return payment;
    const operation = await this.getOrBeginOperation({
      payment,
      type: 'AUTHORIZE',
      amountMinor: payment.amountMinor,
      idempotencyKey: `psp:authorize:${payment.id}`,
      expectedStatuses: ['RISK_APPROVED', 'AUTHORIZATION_FAILED', 'AUTHORIZATION_UNKNOWN'],
      pendingStatus: 'AUTHORIZATION_PENDING',
    });
    return this.executeOperation(operation, payment, correlationId, scenario, 'HTTP');
  }

  async capture(paymentId: string, idempotencyKey: string, correlationId: string, scenario?: PspScenario): Promise<Payment> {
    const payment = await this.requirePayment(paymentId);
    const requestHash = await sha256({ paymentId, operation: 'CAPTURE', amountMinor: payment.authorizedAmountMinor });
    const existing = await this.repository.findOperationByIdempotencyKey(idempotencyKey, requestHash);
    if (existing !== null) return this.executeOperation(await this.prepareFailedRetry(existing, 'CAPTURE_FAILED', 'CAPTURE_PENDING'), payment, correlationId, scenario, 'HTTP');
    if (payment.externalPaymentId === null || payment.authorizedAmountMinor <= 0) throw new PaymentConflictError(`cannot capture from ${payment.status}`);
    const operation = await this.beginOperation(payment, 'CAPTURE', payment.authorizedAmountMinor, idempotencyKey, requestHash, ['AUTHORIZED', 'CAPTURE_FAILED', 'CAPTURE_UNKNOWN'], 'CAPTURE_PENDING');
    return this.executeOperation(operation, payment, correlationId, scenario, 'HTTP');
  }

  async refund(paymentId: string, amountMinor: number, idempotencyKey: string, correlationId: string, scenario?: PspScenario): Promise<Payment> {
    assertMinorUnits(amountMinor);
    const payment = await this.requirePayment(paymentId);
    const requestHash = await sha256({ paymentId, operation: 'REFUND', amountMinor, currency: payment.currency });
    const existing = await this.repository.findOperationByIdempotencyKey(idempotencyKey, requestHash);
    if (existing !== null) return this.executeOperation(await this.prepareFailedRetry(existing, 'REFUND_FAILED', 'REFUND_PENDING'), payment, correlationId, scenario, 'HTTP');
    const remaining = payment.capturedAmountMinor - payment.refundedAmountMinor;
    if (payment.externalPaymentId === null || amountMinor > remaining || !['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_FAILED', 'REFUND_UNKNOWN'].includes(payment.status)) {
      throw new PaymentConflictError('refund exceeds captured balance or payment is not refundable');
    }
    const operation = await this.newOperation(payment, 'REFUND', amountMinor, idempotencyKey, requestHash);
    const started = await this.repository.beginOperation({
      operation,
      expectedStatuses: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_FAILED', 'REFUND_UNKNOWN'],
      pendingStatus: 'REFUND_PENDING',
      event: createEvent({ eventType: eventTypes.paymentRefundRequested, aggregateId: paymentId, correlationId, payload: { paymentId, refundId: operation.id, amountMinor, currency: payment.currency } }),
    });
    return this.executeOperation(started.operation, started.payment, correlationId, scenario, 'HTTP');
  }

  ingestPspWebhook(webhook: WebhookEnvelope): Promise<'ACCEPTED' | 'DUPLICATE'> {
    return this.repository.ingestWebhook(webhook);
  }

  processPspWebhook(workerId: string, webhook: WebhookEnvelope, correlationId: string): Promise<'PROCESSED' | 'IGNORED'> {
    return this.repository.processWebhook(workerId, webhook, correlationId);
  }

  async recoverOperation(operation: PaymentOperation, correlationId: string): Promise<Payment> {
    const payment = await this.requirePayment(operation.paymentId);
    const status = await this.psp.query(operation.id);
    if (status.outcome !== 'NOT_FOUND') return this.repository.resolveOperation({ operationId: operation.id, result: status, source: 'RECOVERY', correlationId });
    return this.executeOperation(operation, payment, correlationId, undefined, 'RECOVERY');
  }

  async reconcileSucceededOperation(input: { operationId: string; amountMinor: number; currency: string; externalPaymentId: string; providerSequence: number }, correlationId: string): Promise<Payment> {
    const operation = await this.repository.findOperationById(input.operationId);
    if (operation === null) throw new PaymentNotFoundError(`payment operation ${input.operationId} not found`);
    if (!['PENDING', 'UNKNOWN'].includes(operation.status)) return this.requirePayment(operation.paymentId);
    if (operation.amountMinor !== input.amountMinor || operation.currency !== input.currency) throw new PaymentConflictError('reconciliation evidence does not match the original operation');
    return this.repository.resolveOperation({ operationId: input.operationId, result: { outcome: 'SUCCEEDED', externalPaymentId: input.externalPaymentId, providerSequence: input.providerSequence }, source: 'RECONCILIATION', correlationId });
  }

  private async getOrBeginOperation(input: {
    payment: Payment;
    type: PaymentOperationType;
    amountMinor: number;
    idempotencyKey: string;
    expectedStatuses: PaymentStatus[];
    pendingStatus: PaymentStatus;
  }): Promise<PaymentOperation> {
    const requestHash = await sha256({ paymentId: input.payment.id, operation: input.type, amountMinor: input.amountMinor });
    const existing = await this.repository.findOperationByIdempotencyKey(input.idempotencyKey, requestHash);
    if (existing !== null) return this.prepareFailedRetry(existing, 'AUTHORIZATION_FAILED', 'AUTHORIZATION_PENDING');
    return (await this.repository.beginOperation({
      operation: await this.newOperation(input.payment, input.type, input.amountMinor, input.idempotencyKey, requestHash),
      expectedStatuses: input.expectedStatuses,
      pendingStatus: input.pendingStatus,
    })).operation;
  }

  private async beginOperation(payment: Payment, type: PaymentOperationType, amountMinor: number, idempotencyKey: string, requestHash: string, expectedStatuses: PaymentStatus[], pendingStatus: PaymentStatus): Promise<PaymentOperation> {
    return (await this.repository.beginOperation({
      operation: await this.newOperation(payment, type, amountMinor, idempotencyKey, requestHash),
      expectedStatuses,
      pendingStatus,
    })).operation;
  }

  private async prepareFailedRetry(operation: PaymentOperation, expectedStatus: PaymentStatus, pendingStatus: PaymentStatus): Promise<PaymentOperation> {
    return operation.status === 'FAILED'
      ? this.repository.restartFailedOperation(operation.id, expectedStatus, pendingStatus)
      : operation;
  }

  private async newOperation(payment: Payment, type: PaymentOperationType, amountMinor: number, idempotencyKey: string, requestHash: string): Promise<PaymentOperation> {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      paymentId: payment.id,
      type,
      amountMinor,
      currency: payment.currency,
      idempotencyKey,
      requestHash,
      status: 'PENDING',
      attemptCount: 0,
      externalPaymentId: null,
      providerSequence: null,
      failureCode: null,
      resolutionSource: null,
      lastAttemptAt: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async executeOperation(operation: PaymentOperation, payment: Payment, correlationId: string, scenario: PspScenario | undefined, source: 'HTTP' | 'RECOVERY'): Promise<Payment> {
    if (['SUCCEEDED', 'DECLINED'].includes(operation.status)) return this.requirePayment(operation.paymentId);
    await this.repository.recordOperationAttempt(operation.id);
    const input: PspOperationInput = {
      operationId: operation.id,
      paymentId: operation.paymentId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      ...(payment.externalPaymentId === null ? {} : { externalPaymentId: payment.externalPaymentId }),
      ...(scenario === undefined ? {} : { scenario }),
    };
    let result: PspResult;
    try {
      result = operation.type === 'AUTHORIZE'
        ? await this.psp.authorize(input)
        : operation.type === 'CAPTURE'
          ? await this.psp.capture(input)
          : await this.psp.refund(input);
    } catch {
      result = { outcome: 'UNKNOWN', code: 'TRANSPORT_ERROR' };
    }
    return this.repository.resolveOperation({ operationId: operation.id, result, source, correlationId });
  }

  private async requirePayment(id: string): Promise<Payment> {
    const payment = await this.repository.findById(id);
    if (payment === null) throw new PaymentNotFoundError(`payment ${id} not found`);
    return payment;
  }
}
