import { structuredLog } from '@ledgerflow/platform';
import type { PaymentApplication } from './payment.application.js';
import type { PaymentRepository } from './payment.domain.js';

export class PaymentRecoveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private ready = false;

  constructor(private readonly repository: PaymentRepository, private readonly application: PaymentApplication, private readonly pendingAgeMilliseconds = 2_000, private readonly pollMilliseconds = 1_000) {}

  async start(): Promise<void> { this.ready = true; this.timer = setInterval(() => void this.poll(), this.pollMilliseconds); this.timer.unref(); await this.poll(); }
  async stop(): Promise<void> { this.ready = false; if (this.timer !== null) clearInterval(this.timer); await this.active; }
  isReady(): boolean { return this.ready; }
  async poll(): Promise<void> { if (this.active !== null) return this.active; this.active = this.run().finally(() => { this.active = null; }); return this.active; }

  private async run(): Promise<void> {
    const operations = await this.repository.findRecoverableOperations(new Date(Date.now() - this.pendingAgeMilliseconds), 20);
    for (const operation of operations) {
      try {
        const payment = await this.application.recoverOperation(operation, crypto.randomUUID());
        structuredLog('info', 'payment operation recovered', { paymentId: operation.paymentId, operationId: operation.id, operationType: operation.type, status: payment.status });
      } catch (error) {
        structuredLog('warn', 'payment operation recovery deferred', { paymentId: operation.paymentId, operationId: operation.id, error: error instanceof Error ? error.message : 'unknown error' });
      }
    }
  }
}
