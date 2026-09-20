import { createEvent, eventTypes, type PaymentStatus } from '@ledgerflow/contracts';
import { sha256 } from '@ledgerflow/platform';
import {
  PaymentConflictError,
  PaymentNotFoundError,
  assertMinorUnits,
  type Payment,
  type PaymentRepository,
  type PspPort,
  type RiskPort,
} from './payment.domain.js';

export interface CreatePaymentCommand {
  walletId: string;
  merchantId: string;
  customerId: string;
  amountMinor: number;
  currency: string;
}

export class PaymentApplication {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly risk: RiskPort,
    private readonly psp: PspPort,
  ) {}

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
      amountMinor: command.amountMinor,
      currency: command.currency,
      status: 'RISK_CHECKING',
      authorizedAmountMinor: 0,
      capturedAmountMinor: 0,
      refundedAmountMinor: 0,
      externalPaymentId: null,
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

  async authorize(paymentId: string, customerId: string, correlationId: string): Promise<Payment> {
    const payment = await this.requirePayment(paymentId);
    if (payment.status !== 'RISK_CHECKING') throw new PaymentConflictError(`cannot authorize from ${payment.status}`);
    const decision = await this.risk.evaluate({ customerId, amountMinor: payment.amountMinor, currency: payment.currency });
    if (decision.decision === 'REJECT') {
      return this.transition(payment, ['RISK_CHECKING'], 'FAILED', eventTypes.riskRejected, correlationId, {
        failureCode: decision.reasonCodes.join(','),
      });
    }
    const pending = await this.repository.transition({
      paymentId,
      expectedStatuses: ['RISK_CHECKING'],
      patch: { status: 'AUTHORIZATION_PENDING' },
      event: createEvent({ eventType: eventTypes.riskApproved, aggregateId: paymentId, correlationId, payload: { paymentId, reasonCodes: decision.reasonCodes } }),
    });
    const result = await this.psp.authorize({ paymentId, amountMinor: payment.amountMinor, currency: payment.currency });
    if (result.outcome === 'UNKNOWN') return pending;
    if (result.outcome === 'DECLINED') {
      return this.transition(pending, ['AUTHORIZATION_PENDING'], 'FAILED', eventTypes.paymentAuthorizationFailed, correlationId, { failureCode: result.code });
    }
    return this.transition(pending, ['AUTHORIZATION_PENDING'], 'AUTHORIZED', eventTypes.paymentAuthorized, correlationId, {
      externalPaymentId: result.externalPaymentId,
      authorizedAmountMinor: payment.amountMinor,
    });
  }

  async capture(paymentId: string, correlationId: string): Promise<Payment> {
    const payment = await this.requirePayment(paymentId);
    if (payment.status !== 'AUTHORIZED' || payment.externalPaymentId === null) throw new PaymentConflictError(`cannot capture from ${payment.status}`);
    const pending = await this.repository.transition({ paymentId, expectedStatuses: ['AUTHORIZED'], patch: { status: 'CAPTURE_PENDING' } });
    const result = await this.psp.capture({ paymentId, externalPaymentId: payment.externalPaymentId, amountMinor: payment.authorizedAmountMinor });
    if (result.outcome === 'UNKNOWN') return pending;
    if (result.outcome === 'DECLINED') return this.transition(pending, ['CAPTURE_PENDING'], 'AUTHORIZED', eventTypes.paymentCaptureFailed, correlationId, { failureCode: result.code });
    return this.transition(pending, ['CAPTURE_PENDING'], 'CAPTURED', eventTypes.paymentCaptured, correlationId, { capturedAmountMinor: payment.authorizedAmountMinor });
  }

  async refund(paymentId: string, amountMinor: number, correlationId: string): Promise<Payment> {
    assertMinorUnits(amountMinor);
    const payment = await this.requirePayment(paymentId);
    const remaining = payment.capturedAmountMinor - payment.refundedAmountMinor;
    if (!['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) || amountMinor > remaining || payment.externalPaymentId === null) {
      throw new PaymentConflictError('refund exceeds captured balance or payment is not refundable');
    }
    const previousStatus = payment.status;
    const pending = await this.repository.transition({
      paymentId,
      expectedStatuses: [previousStatus],
      patch: { status: 'REFUND_PENDING' },
      event: createEvent({ eventType: eventTypes.paymentRefundRequested, aggregateId: paymentId, correlationId, payload: { paymentId, amountMinor, currency: payment.currency } }),
    });
    const result = await this.psp.refund({ paymentId, externalPaymentId: payment.externalPaymentId, amountMinor });
    if (result.outcome === 'UNKNOWN') return pending;
    if (result.outcome === 'DECLINED') return this.repository.transition({ paymentId, expectedStatuses: ['REFUND_PENDING'], patch: { status: previousStatus, failureCode: result.code } });
    const refundedAmountMinor = payment.refundedAmountMinor + amountMinor;
    const nextStatus = refundedAmountMinor === payment.capturedAmountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    return this.transition(pending, ['REFUND_PENDING'], nextStatus, eventTypes.paymentRefunded, correlationId, { refundedAmountMinor });
  }

  async applyPspWebhook(input: { eventId: string; paymentId: string; outcome: 'AUTHORIZED' | 'CAPTURED' | 'REFUNDED' | 'DECLINED'; externalPaymentId: string; correlationId: string }): Promise<Payment | null> {
    const payment = await this.requirePayment(input.paymentId);
    let expectedStatuses: PaymentStatus[];
    let status: PaymentStatus;
    let eventType: Parameters<typeof createEvent>[0]['eventType'];
    let patch: Partial<Payment>;
    if (input.outcome === 'AUTHORIZED' && payment.status === 'AUTHORIZATION_PENDING') {
      expectedStatuses = ['AUTHORIZATION_PENDING'];
      status = 'AUTHORIZED';
      eventType = eventTypes.paymentAuthorized;
      patch = { externalPaymentId: input.externalPaymentId, authorizedAmountMinor: payment.amountMinor };
    } else if (input.outcome === 'CAPTURED' && ['AUTHORIZATION_PENDING', 'AUTHORIZED', 'CAPTURE_PENDING'].includes(payment.status)) {
      expectedStatuses = [payment.status];
      status = 'CAPTURED';
      eventType = eventTypes.paymentCaptured;
      patch = { externalPaymentId: input.externalPaymentId, authorizedAmountMinor: payment.amountMinor, capturedAmountMinor: payment.amountMinor };
    } else if (input.outcome === 'DECLINED' && ['AUTHORIZATION_PENDING', 'CAPTURE_PENDING'].includes(payment.status)) {
      expectedStatuses = [payment.status];
      status = 'FAILED';
      eventType = eventTypes.paymentAuthorizationFailed;
      patch = { failureCode: 'PSP_DECLINED' };
    } else {
      return payment;
    }
    return this.repository.transitionFromWebhook({
      eventId: input.eventId,
      paymentId: payment.id,
      expectedStatuses,
      patch: { ...patch, status },
      event: createEvent({ eventType, aggregateId: payment.id, correlationId: input.correlationId, payload: { paymentId: payment.id, status, amountMinor: payment.amountMinor, currency: payment.currency } }),
    });
  }

  private async requirePayment(id: string): Promise<Payment> {
    const payment = await this.repository.findById(id);
    if (payment === null) throw new PaymentNotFoundError(`payment ${id} not found`);
    return payment;
  }

  private transition(
    payment: Payment,
    expectedStatuses: PaymentStatus[],
    status: PaymentStatus,
    eventType: Parameters<typeof createEvent>[0]['eventType'],
    correlationId: string,
    patch: Partial<Payment>,
  ): Promise<Payment> {
    return this.repository.transition({
      paymentId: payment.id,
      expectedStatuses,
      patch: { ...patch, status },
      event: createEvent({
        eventType,
        aggregateId: payment.id,
        correlationId,
        payload: {
          paymentId: payment.id,
          walletId: payment.walletId,
          merchantId: payment.merchantId,
          status,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
        },
      }),
    });
  }
}
