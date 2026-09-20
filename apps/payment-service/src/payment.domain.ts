import type { EventEnvelope, PaymentStatus } from '@ledgerflow/contracts';

export interface Payment {
  id: string;
  walletId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  authorizedAmountMinor: number;
  capturedAmountMinor: number;
  refundedAmountMinor: number;
  externalPaymentId: string | null;
  failureCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type PspResult =
  | { outcome: 'APPROVED'; externalPaymentId: string }
  | { outcome: 'DECLINED'; code: string }
  | { outcome: 'UNKNOWN'; requestId: string };

export interface RiskDecision {
  decision: 'APPROVE' | 'REJECT';
  reasonCodes: string[];
}

export interface PaymentRepository {
  create(input: Payment, idempotencyKey: string, requestHash: string, event: EventEnvelope): Promise<Payment>;
  findById(id: string): Promise<Payment | null>;
  findIdempotentResponse(idempotencyKey: string, requestHash: string): Promise<Payment | null>;
  transition(input: {
    paymentId: string;
    expectedStatuses: PaymentStatus[];
    patch: Partial<Payment>;
    event?: EventEnvelope;
  }): Promise<Payment>;
  transitionFromWebhook(input: {
    eventId: string;
    paymentId: string;
    expectedStatuses: PaymentStatus[];
    patch: Partial<Payment>;
    event?: EventEnvelope;
  }): Promise<Payment | null>;
}

export interface RiskPort {
  evaluate(input: { customerId: string; amountMinor: number; currency: string }): Promise<RiskDecision>;
}

export interface PspPort {
  authorize(input: { paymentId: string; amountMinor: number; currency: string }): Promise<PspResult>;
  capture(input: { paymentId: string; externalPaymentId: string; amountMinor: number }): Promise<PspResult>;
  refund(input: { paymentId: string; externalPaymentId: string; amountMinor: number }): Promise<PspResult>;
}

export class PaymentConflictError extends Error {}
export class IdempotencyMismatchError extends Error {}
export class PaymentNotFoundError extends Error {}

export function assertMinorUnits(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new RangeError('amountMinor must be a positive safe integer');
  }
}
