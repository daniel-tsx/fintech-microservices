import type { EventEnvelope } from '@ledgerflow/contracts';
import {
  IdempotencyMismatchError,
  PaymentConflictError,
  PaymentNotFoundError,
  type Payment,
  type PaymentRepository,
} from './payment.domain.js';

interface IdempotencyRecord { requestHash: string; paymentId: string }

export class InMemoryPaymentRepository implements PaymentRepository {
  readonly payments = new Map<string, Payment>();
  readonly outbox: EventEnvelope[] = [];
  readonly inbox = new Set<string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  async create(payment: Payment, key: string, requestHash: string, event: EventEnvelope): Promise<Payment> {
    const existing = this.idempotency.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw new IdempotencyMismatchError('key reused with another payload');
      return this.requirePayment(existing.paymentId);
    }
    this.idempotency.set(key, { requestHash, paymentId: payment.id });
    this.payments.set(payment.id, structuredClone(payment));
    this.outbox.push(structuredClone(event));
    return structuredClone(payment);
  }

  async findById(id: string): Promise<Payment | null> {
    const payment = this.payments.get(id);
    return payment === undefined ? null : structuredClone(payment);
  }

  async findIdempotentResponse(key: string, requestHash: string): Promise<Payment | null> {
    const existing = this.idempotency.get(key);
    if (existing === undefined) return null;
    if (existing.requestHash !== requestHash) throw new IdempotencyMismatchError('key reused with another payload');
    return this.requirePayment(existing.paymentId);
  }

  async transition(input: {
    paymentId: string;
    expectedStatuses: Payment['status'][];
    patch: Partial<Payment>;
    event?: EventEnvelope;
  }): Promise<Payment> {
    const current = this.requirePayment(input.paymentId);
    if (!input.expectedStatuses.includes(current.status)) {
      throw new PaymentConflictError(`cannot transition payment from ${current.status}`);
    }
    const next = { ...current, ...input.patch, version: current.version + 1, updatedAt: new Date().toISOString() };
    this.payments.set(next.id, next);
    if (input.event !== undefined) this.outbox.push(structuredClone(input.event));
    return structuredClone(next);
  }

  async transitionFromWebhook(input: {
    eventId: string;
    paymentId: string;
    expectedStatuses: Payment['status'][];
    patch: Partial<Payment>;
    event?: EventEnvelope;
  }): Promise<Payment | null> {
    if (this.inbox.has(input.eventId)) return null;
    const result = await this.transition(input);
    this.inbox.add(input.eventId);
    return result;
  }

  private requirePayment(id: string): Payment {
    const payment = this.payments.get(id);
    if (payment === undefined) throw new PaymentNotFoundError(`payment ${id} not found`);
    return structuredClone(payment);
  }
}
