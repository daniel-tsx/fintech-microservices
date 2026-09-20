import { z } from 'zod';

export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const minorUnitsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const eventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string().min(1),
  eventVersion: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  aggregateId: z.string().uuid(),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope<T extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  'payload'
> & { payload: T };

export const eventTypes = {
  paymentCreated: 'payment.created.v1',
  riskApproved: 'risk.approved.v1',
  riskRejected: 'risk.rejected.v1',
  paymentAuthorized: 'payment.authorized.v1',
  paymentAuthorizationFailed: 'payment.authorization-failed.v1',
  paymentCaptured: 'payment.captured.v1',
  paymentCaptureFailed: 'payment.capture-failed.v1',
  paymentRefundRequested: 'payment.refund-requested.v1',
  paymentRefunded: 'payment.refunded.v1',
  transferRequested: 'transfer.requested.v1',
  transferCompleted: 'transfer.completed.v1',
  ledgerEntryPosted: 'ledger.entry-posted.v1',
  settlementCreated: 'settlement.created.v1',
  reconciliationMismatchDetected: 'reconciliation.mismatch-detected.v1',
} as const;

export type EventType = (typeof eventTypes)[keyof typeof eventTypes];

export const paymentEventsTopic = 'ledgerflow.payments.v1';

export function createEvent<T extends Record<string, unknown>>(input: {
  eventType: EventType;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  payload: T;
}): EventEnvelope<T> {
  return {
    eventId: crypto.randomUUID(),
    eventType: input.eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    correlationId: input.correlationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    aggregateId: input.aggregateId,
    payload: input.payload,
  };
}

export type PaymentStatus =
  | 'PENDING'
  | 'RISK_CHECKING'
  | 'AUTHORIZATION_PENDING'
  | 'AUTHORIZED'
  | 'CAPTURE_PENDING'
  | 'CAPTURED'
  | 'FAILED'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface PaymentCreatedPayload extends Money {
  paymentId: string;
  walletId: string;
  merchantId: string;
}

export const paymentCapturedPayloadSchema = z.object({
  paymentId: z.string().uuid(),
  walletId: z.string().uuid(),
  merchantId: z.string().uuid(),
  status: z.literal('CAPTURED'),
  amountMinor: minorUnitsSchema,
  currency: currencySchema,
});

export type PaymentCapturedPayload = z.infer<typeof paymentCapturedPayloadSchema>;

export const paymentCapturedEventSchema = eventEnvelopeSchema.extend({
  eventType: z.literal(eventTypes.paymentCaptured),
  eventVersion: z.literal(1),
  payload: paymentCapturedPayloadSchema,
});

export type PaymentCapturedEvent = z.infer<typeof paymentCapturedEventSchema>;

export interface LedgerPostingPayload extends Money {
  journalId: string;
  referenceType: 'PAYMENT' | 'REFUND' | 'TRANSFER' | 'SETTLEMENT';
  referenceId: string;
}
