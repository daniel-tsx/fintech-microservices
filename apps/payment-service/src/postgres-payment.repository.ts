import { paymentEventsTopic, type EventEnvelope } from '@ledgerflow/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { idempotencyKeys, inboxEvents, outboxEvents, payments } from './database.schema.js';
import type { PaymentDatabase } from './database.js';
import {
  IdempotencyMismatchError,
  PaymentConflictError,
  PaymentNotFoundError,
  type Payment,
  type PaymentRepository,
} from './payment.domain.js';

export interface PaymentTransactionProbe {
  afterPaymentInsert?(): Promise<void>;
}

type PaymentRow = typeof payments.$inferSelect;

function toPayment(row: PaymentRow): Payment {
  return {
    ...row,
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

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly db: PaymentDatabase, private readonly probe: PaymentTransactionProbe = {}) {}

  async create(payment: Payment, key: string, requestHash: string, event: EventEnvelope): Promise<Payment> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.insert(payments).values({
          ...payment,
          createdAt: new Date(payment.createdAt),
          updatedAt: new Date(payment.updatedAt),
        });
        await this.probe.afterPaymentInsert?.();
        await tx.insert(idempotencyKeys).values({ key, requestHash, paymentId: payment.id });
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
    const [row] = await this.db
      .select({ idempotency: idempotencyKeys, payment: payments })
      .from(idempotencyKeys)
      .innerJoin(payments, eq(idempotencyKeys.paymentId, payments.id))
      .where(eq(idempotencyKeys.key, key))
      .limit(1);
    if (row === undefined) return null;
    if (row.idempotency.requestHash !== requestHash) throw new IdempotencyMismatchError('key reused with another payload');
    return toPayment(row.payment);
  }

  async transition(input: {
    paymentId: string;
    expectedStatuses: Payment['status'][];
    patch: Partial<Payment>;
    event?: EventEnvelope;
  }): Promise<Payment> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(payments).set({
        ...(input.patch.status === undefined ? {} : { status: input.patch.status }),
        ...(input.patch.authorizedAmountMinor === undefined ? {} : { authorizedAmountMinor: input.patch.authorizedAmountMinor }),
        ...(input.patch.capturedAmountMinor === undefined ? {} : { capturedAmountMinor: input.patch.capturedAmountMinor }),
        ...(input.patch.refundedAmountMinor === undefined ? {} : { refundedAmountMinor: input.patch.refundedAmountMinor }),
        ...(input.patch.externalPaymentId === undefined ? {} : { externalPaymentId: input.patch.externalPaymentId }),
        ...(input.patch.failureCode === undefined ? {} : { failureCode: input.patch.failureCode }),
        updatedAt: new Date(),
        version: sql`${payments.version} + 1`,
      }).where(and(eq(payments.id, input.paymentId), inArray(payments.status, input.expectedStatuses))).returning();
      if (row === undefined) await this.throwTransitionError(input.paymentId);
      if (input.event !== undefined) await tx.insert(outboxEvents).values(outboxValue(input.event));
      return toPayment(row!);
    });
  }

  async transitionFromWebhook(input: {
    eventId: string;
    paymentId: string;
    expectedStatuses: Payment['status'][];
    patch: Partial<Payment>;
    event?: EventEnvelope;
  }): Promise<Payment | null> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.insert(inboxEvents).values({ eventId: input.eventId, eventType: 'psp.webhook' }).onConflictDoNothing().returning({ eventId: inboxEvents.eventId });
      if (claimed.length === 0) return null;
      const [row] = await tx.update(payments).set({
        ...(input.patch.status === undefined ? {} : { status: input.patch.status }),
        ...(input.patch.authorizedAmountMinor === undefined ? {} : { authorizedAmountMinor: input.patch.authorizedAmountMinor }),
        ...(input.patch.capturedAmountMinor === undefined ? {} : { capturedAmountMinor: input.patch.capturedAmountMinor }),
        ...(input.patch.refundedAmountMinor === undefined ? {} : { refundedAmountMinor: input.patch.refundedAmountMinor }),
        ...(input.patch.externalPaymentId === undefined ? {} : { externalPaymentId: input.patch.externalPaymentId }),
        ...(input.patch.failureCode === undefined ? {} : { failureCode: input.patch.failureCode }),
        updatedAt: new Date(),
        version: sql`${payments.version} + 1`,
      }).where(and(eq(payments.id, input.paymentId), inArray(payments.status, input.expectedStatuses))).returning();
      if (row === undefined) await this.throwTransitionError(input.paymentId);
      if (input.event !== undefined) await tx.insert(outboxEvents).values(outboxValue(input.event));
      return toPayment(row!);
    });
  }

  private async throwTransitionError(paymentId: string): Promise<never> {
    const current = await this.findById(paymentId);
    if (current === null) throw new PaymentNotFoundError(`payment ${paymentId} not found`);
    throw new PaymentConflictError(`cannot transition payment from ${current.status}`);
  }
}
