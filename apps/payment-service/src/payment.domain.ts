import type { EventEnvelope, PaymentStatus, PspScenario } from '@ledgerflow/contracts';

export type PaymentOperationType = 'AUTHORIZE' | 'CAPTURE' | 'REFUND';
export type PaymentOperationStatus = 'PENDING' | 'SUCCEEDED' | 'DECLINED' | 'FAILED' | 'UNKNOWN';
export type ResolutionSource = 'HTTP' | 'WEBHOOK' | 'RECOVERY' | 'RECONCILIATION';

export interface Payment {
  id: string;
  walletId: string;
  merchantId: string;
  customerId: string | null;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  authorizedAmountMinor: number;
  capturedAmountMinor: number;
  refundedAmountMinor: number;
  externalPaymentId: string | null;
  providerSequence: number;
  failureCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentOperation {
  id: string;
  paymentId: string;
  type: PaymentOperationType;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  requestHash: string;
  status: PaymentOperationStatus;
  attemptCount: number;
  externalPaymentId: string | null;
  providerSequence: number | null;
  failureCode: string | null;
  resolutionSource: ResolutionSource | null;
  lastAttemptAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PspResult =
  | { outcome: 'SUCCEEDED'; externalPaymentId: string; providerSequence: number }
  | { outcome: 'DECLINED'; externalPaymentId: string; providerSequence: number; code: string }
  | { outcome: 'FAILED'; code: string }
  | { outcome: 'UNKNOWN'; code: string };

export type PspStatus = PspResult | { outcome: 'NOT_FOUND' };

export interface RiskDecision {
  decision: 'APPROVE' | 'REJECT';
  reasonCodes: string[];
}

export interface WebhookEnvelope {
  eventId: string;
  eventType: 'AUTHORIZED' | 'CAPTURED' | 'REFUNDED' | 'DECLINED';
  operationId: string;
  operationType: PaymentOperationType;
  paymentId: string;
  externalPaymentId: string;
  amountMinor: number;
  currency: string;
  providerSequence: number;
  occurredAt: string;
}

export interface PaymentRepository {
  create(input: Payment, idempotencyKey: string, requestHash: string, event: EventEnvelope): Promise<Payment>;
  findById(id: string): Promise<Payment | null>;
  findIdempotentResponse(idempotencyKey: string, requestHash: string): Promise<Payment | null>;
  transition(input: { paymentId: string; expectedStatuses: PaymentStatus[]; patch: Partial<Payment>; event?: EventEnvelope; source: string; operationId?: string }): Promise<Payment>;
  findOperationByIdempotencyKey(key: string, requestHash: string): Promise<PaymentOperation | null>;
  findOperationById(id: string): Promise<PaymentOperation | null>;
  beginOperation(input: { operation: PaymentOperation; expectedStatuses: PaymentStatus[]; pendingStatus: PaymentStatus; event?: EventEnvelope }): Promise<{ payment: Payment; operation: PaymentOperation; created: boolean }>;
  restartFailedOperation(operationId: string, expectedStatus: PaymentStatus, pendingStatus: PaymentStatus): Promise<PaymentOperation>;
  recordOperationAttempt(operationId: string): Promise<void>;
  resolveOperation(input: { operationId: string; result: PspResult; source: ResolutionSource; correlationId: string }): Promise<Payment>;
  ingestWebhook(input: WebhookEnvelope): Promise<'ACCEPTED' | 'DUPLICATE'>;
  claimWebhookBatch(workerId: string, limit: number, leaseMilliseconds: number): Promise<WebhookEnvelope[]>;
  processWebhook(workerId: string, webhook: WebhookEnvelope, correlationId: string): Promise<'PROCESSED' | 'IGNORED'>;
  rescheduleWebhook(workerId: string, eventId: string, error: string): Promise<void>;
  findRecoverableOperations(olderThan: Date, limit: number): Promise<PaymentOperation[]>;
  listForReconciliation(windowStart: Date, windowEnd: Date, afterId: string | undefined, limit: number): Promise<Array<Payment & { operations: PaymentOperation[] }>>;
}

export interface RiskPort {
  evaluate(input: { paymentId: string; customerId: string; amountMinor: number; currency: string }): Promise<RiskDecision>;
}

export interface PspOperationInput {
  operationId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  externalPaymentId?: string;
  scenario?: PspScenario;
}

export interface PspPort {
  authorize(input: PspOperationInput): Promise<PspResult>;
  capture(input: PspOperationInput): Promise<PspResult>;
  refund(input: PspOperationInput): Promise<PspResult>;
  query(operationId: string): Promise<PspStatus>;
}

export class PaymentConflictError extends Error {}
export class IdempotencyMismatchError extends Error {}
export class PaymentNotFoundError extends Error {}
export class PaymentOperationNotFoundError extends Error {}

export function assertMinorUnits(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError('amountMinor must be a positive safe integer');
}
