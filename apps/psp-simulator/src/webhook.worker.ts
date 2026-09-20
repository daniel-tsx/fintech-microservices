import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { structuredLog } from '@ledgerflow/platform';
import type { WebhookEnvelope } from '../../payment-service/src/payment.domain.js';
import { pendingWebhooks } from './database.schema.js';
import type { PspClient, PspDatabase } from './database.js';
import type { PspWebhookScheduler } from './postgres-psp.repository.js';

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export class DurablePspWebhookScheduler implements PspWebhookScheduler {
  constructor(private readonly db: PspDatabase, private readonly endpoint: string, private readonly secret: string) {}

  async enqueue(webhook: WebhookEnvelope, delayMilliseconds: number, copies = 1): Promise<void> {
    await this.db.insert(pendingWebhooks).values(Array.from({ length: copies }, () => ({
      id: crypto.randomUUID(),
      eventId: webhook.eventId,
      eventType: webhook.eventType,
      operationId: webhook.operationId,
      paymentId: webhook.paymentId,
      providerSequence: webhook.providerSequence,
      payload: webhook,
      deliverAfter: new Date(Date.now() + delayMilliseconds),
    })));
  }

  async deliverNow(webhook: WebhookEnvelope): Promise<void> {
    await this.enqueue(webhook, 0);
    await this.send(webhook);
    await this.db.update(pendingWebhooks).set({ deliveredAt: new Date() }).where(and(eq(pendingWebhooks.eventId, webhook.eventId), sql`${pendingWebhooks.deliveredAt} IS NULL`));
  }

  async send(webhook: WebhookEnvelope): Promise<void> {
    const rawBody = JSON.stringify(webhook);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-psp-timestamp': String(timestamp), 'x-psp-signature': signWebhook(this.secret, timestamp, rawBody) },
      body: rawBody,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`Payment webhook endpoint returned HTTP ${response.status}`);
  }
}

export class PspWebhookWorker {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private readonly workerId = `psp-webhook-${process.pid}-${crypto.randomUUID()}`;
  constructor(private readonly client: PspClient, private readonly db: PspDatabase, private readonly scheduler: DurablePspWebhookScheduler, private readonly pollMilliseconds = 250) {}

  async start(): Promise<void> { this.timer = setInterval(() => void this.poll(), this.pollMilliseconds); this.timer.unref(); await this.poll(); }
  async stop(): Promise<void> { if (this.timer !== null) clearInterval(this.timer); await this.active; }
  async poll(): Promise<void> { if (this.active !== null) return this.active; this.active = this.run().finally(() => { this.active = null; }); return this.active; }

  private async run(): Promise<void> {
    const rows = await this.client<Array<{ id: string; payload: WebhookEnvelope }>>`
      WITH candidates AS (
        SELECT id FROM pending_webhooks
        WHERE delivered_at IS NULL AND deliver_after <= now()
          AND (locked_at IS NULL OR locked_at < now() - interval '30 seconds')
        ORDER BY deliver_after FOR UPDATE SKIP LOCKED LIMIT 20
      )
      UPDATE pending_webhooks AS webhook SET locked_at = now(), locked_by = ${this.workerId}
      FROM candidates WHERE webhook.id = candidates.id RETURNING webhook.id, webhook.payload
    `;
    for (const row of rows) {
      try {
        await this.scheduler.send(row.payload);
        await this.db.update(pendingWebhooks).set({ deliveredAt: new Date(), lockedAt: null, lockedBy: null, lastError: null }).where(eq(pendingWebhooks.id, row.id));
      } catch (error) {
        await this.db.update(pendingWebhooks).set({ attemptCount: sql`${pendingWebhooks.attemptCount} + 1`, deliverAfter: new Date(Date.now() + 500), lockedAt: null, lockedBy: null, lastError: error instanceof Error ? error.message : 'unknown error' }).where(eq(pendingWebhooks.id, row.id));
        structuredLog('warn', 'PSP webhook delivery failed; retry scheduled', { deliveryId: row.id });
      }
    }
  }
}
