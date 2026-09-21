import { repairEventsTopic, settlementEventsTopic } from '@ledgerflow/contracts';
import { OutboxPublisher, structuredLog, type KafkaMessageProducer } from '@ledgerflow/platform';
import type { ReconciliationOutboxStore } from './reconciliation.store.js';

export class ReconciliationOutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private ready = false;
  constructor(private readonly store: ReconciliationOutboxStore, private readonly producer: KafkaMessageProducer, private readonly pollMilliseconds = 500, private readonly batchSize = 50) {}
  async start() { await this.producer.ensureTopic(settlementEventsTopic); await this.producer.ensureTopic(repairEventsTopic); await this.producer.connect(); this.ready = true; this.timer = setInterval(() => void this.poll(), this.pollMilliseconds); this.timer.unref(); await this.poll(); structuredLog('info', 'reconciliation outbox worker started', { topics: [settlementEventsTopic, repairEventsTopic] }); }
  async stop() { this.ready = false; if (this.timer !== null) clearInterval(this.timer); await this.active; await this.producer.disconnect(); }
  isReady() { return this.ready; }
  async poll() { if (this.active !== null) return this.active; this.active = new OutboxPublisher(this.store, this.producer).publishBatch(this.batchSize).then((result) => { if (Object.values(result).some((count) => count > 0)) structuredLog('info', 'reconciliation outbox batch completed', result); }).catch((error: unknown) => structuredLog('error', 'reconciliation outbox poll failed', { error: error instanceof Error ? error.message : 'unknown' })).finally(() => { this.active = null; }); return this.active; }
}
