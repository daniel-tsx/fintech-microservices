import { structuredLog } from '@ledgerflow/platform';
import type { PaymentApplication } from './payment.application.js';
import type { PaymentRepository } from './payment.domain.js';

export class PaymentWebhookWorker {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private ready = false;
  private readonly workerId = `payment-webhook-${process.pid}-${crypto.randomUUID()}`;

  constructor(private readonly repository: PaymentRepository, private readonly application: PaymentApplication, private readonly pollMilliseconds = 250, private readonly batchSize = 20) {}

  async start(): Promise<void> { this.ready = true; this.timer = setInterval(() => void this.poll(), this.pollMilliseconds); this.timer.unref(); await this.poll(); }
  async stop(): Promise<void> { this.ready = false; if (this.timer !== null) clearInterval(this.timer); await this.active; }
  isReady(): boolean { return this.ready; }
  async poll(): Promise<void> { if (this.active !== null) return this.active; this.active = this.run().finally(() => { this.active = null; }); return this.active; }

  private async run(): Promise<void> {
    const webhooks = await this.repository.claimWebhookBatch(this.workerId, this.batchSize, 30_000);
    for (const webhook of webhooks) {
      try {
        const result = await this.application.processPspWebhook(this.workerId, webhook, webhook.eventId);
        structuredLog('info', result === 'PROCESSED' ? 'PSP webhook applied' : 'PSP webhook ignored', { eventId: webhook.eventId, paymentId: webhook.paymentId, operationId: webhook.operationId, providerSequence: webhook.providerSequence });
      } catch (error) {
        await this.repository.rescheduleWebhook(this.workerId, webhook.eventId, error instanceof Error ? error.message : 'unknown webhook failure');
        structuredLog('warn', 'PSP webhook processing retry scheduled', { eventId: webhook.eventId, paymentId: webhook.paymentId });
      }
    }
  }
}
