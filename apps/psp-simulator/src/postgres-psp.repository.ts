import { eq } from 'drizzle-orm';
import type { PspOperationInput, PspPort, PspResult, PspStatus, PaymentOperationType, WebhookEnvelope } from '../../payment-service/src/payment.domain.js';
import { pspOperations } from './database.schema.js';
import type { PspDatabase } from './database.js';

export class PspHttpError extends Error {}

export interface PspWebhookScheduler {
  deliverNow(webhook: WebhookEnvelope): Promise<void>;
  enqueue(webhook: WebhookEnvelope, delayMilliseconds: number, copies?: number): Promise<void>;
}

function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

export class PostgresPspRepository implements PspPort {
  constructor(private readonly db: PspDatabase, private readonly webhooks: PspWebhookScheduler) {}

  authorize(input: PspOperationInput): Promise<PspResult> { return this.execute('AUTHORIZE', input); }
  capture(input: PspOperationInput): Promise<PspResult> { return this.execute('CAPTURE', input); }
  refund(input: PspOperationInput): Promise<PspResult> { return this.execute('REFUND', input); }

  async query(operationId: string): Promise<PspStatus> {
    const [row] = await this.db.select().from(pspOperations).where(eq(pspOperations.operationId, operationId)).limit(1);
    return row === undefined ? { outcome: 'NOT_FOUND' } : this.toResult(row);
  }

  async allRecords() {
    return this.db.select().from(pspOperations).orderBy(pspOperations.providerSequence);
  }

  private async execute(operation: PaymentOperationType, input: PspOperationInput): Promise<PspResult> {
    const prior = await this.query(input.operationId);
    if (prior.outcome !== 'NOT_FOUND') return prior;
    const scenario = input.scenario ?? 'SUCCESS';
    if (scenario === 'HTTP_500') throw new PspHttpError('simulated PSP HTTP 500 before processing');
    if (scenario === 'TIMEOUT_BEFORE_PROCESSING') {
      await sleep(2_500);
      return { outcome: 'FAILED', code: 'NOT_PROCESSED' };
    }
    if (scenario === 'SLOW_SUCCESS' || scenario === 'SLOW_DECLINE') await sleep(500);
    const status = scenario === 'DECLINE' || scenario === 'SLOW_DECLINE' ? 'DECLINED' : 'SUCCEEDED';
    const externalPaymentId = input.externalPaymentId ?? crypto.randomUUID();
    const inserted = await this.db.insert(pspOperations).values({
      id: crypto.randomUUID(),
      intentKey: `${operation}:${input.operationId}`,
      operationId: input.operationId,
      externalPaymentId,
      internalPaymentId: input.paymentId,
      operation,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status,
      scenario,
    }).onConflictDoNothing({ target: pspOperations.operationId }).returning();
    const row = inserted[0] ?? (await this.db.select().from(pspOperations).where(eq(pspOperations.operationId, input.operationId)).limit(1))[0];
    if (row === undefined) throw new Error('PSP operation insert did not return a record');
    const webhook = this.toWebhook(row);
    if (scenario === 'WEBHOOK_BEFORE_HTTP_RESPONSE') await this.webhooks.deliverNow(webhook);
    if (scenario === 'WEBHOOK_AFTER_HTTP_RESPONSE') await this.webhooks.enqueue(webhook, 50);
    if (scenario === 'DUPLICATE_WEBHOOK') await this.webhooks.enqueue(webhook, 50, 2);
    if (scenario === 'DELAYED_WEBHOOK') await this.webhooks.enqueue(webhook, 1_000);
    if (scenario === 'TIMEOUT_AFTER_PROCESSING' || scenario === 'HTTP_RESPONSE_LOST_AFTER_SUCCESS') {
      await this.webhooks.enqueue(webhook, 50);
      await sleep(2_500);
    }
    if (scenario === 'OUT_OF_ORDER_WEBHOOK') {
      await this.webhooks.enqueue(webhook, 10);
      const [authorization] = await this.db.select().from(pspOperations)
        .where(eq(pspOperations.internalPaymentId, input.paymentId)).orderBy(pspOperations.providerSequence).limit(1);
      if (authorization !== undefined && authorization.operation === 'AUTHORIZE') await this.webhooks.enqueue(this.toWebhook(authorization), 100);
    }
    return this.toResult(row);
  }

  private toResult(row: typeof pspOperations.$inferSelect): PspResult {
    return row.status === 'SUCCEEDED'
      ? { outcome: 'SUCCEEDED', externalPaymentId: row.externalPaymentId, providerSequence: row.providerSequence }
      : { outcome: 'DECLINED', externalPaymentId: row.externalPaymentId, providerSequence: row.providerSequence, code: 'PSP_DECLINED' };
  }

  private toWebhook(row: typeof pspOperations.$inferSelect): WebhookEnvelope {
    const eventType = row.status === 'DECLINED' ? 'DECLINED' : row.operation === 'AUTHORIZE' ? 'AUTHORIZED' : row.operation === 'CAPTURE' ? 'CAPTURED' : 'REFUNDED';
    return {
      eventId: crypto.randomUUID(),
      eventType,
      operationId: row.operationId,
      operationType: row.operation,
      paymentId: row.internalPaymentId,
      externalPaymentId: row.externalPaymentId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      providerSequence: row.providerSequence,
      occurredAt: row.updatedAt.toISOString(),
    };
  }
}
