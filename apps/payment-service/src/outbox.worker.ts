import { paymentEventsTopic } from '@ledgerflow/contracts';
import { OutboxPublisher, structuredLog, type KafkaMessageProducer } from '@ledgerflow/platform';
import type { PostgresOutboxStore } from './postgres-outbox.store.js';

export class PaymentOutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private ready = false;

  constructor(
    private readonly store: PostgresOutboxStore,
    private readonly producer: KafkaMessageProducer,
    private readonly pollMilliseconds = 500,
    private readonly batchSize = 50,
  ) {}

  async start(): Promise<void> {
    await this.producer.ensureTopic(paymentEventsTopic);
    await this.producer.connect();
    this.ready = true;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMilliseconds);
    this.timer.unref();
    await this.poll();
    structuredLog('info', 'payment outbox worker started', { topic: paymentEventsTopic, batchSize: this.batchSize, pollMilliseconds: this.pollMilliseconds });
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.timer !== null) clearInterval(this.timer);
    await this.activeRun;
    await this.producer.disconnect();
    structuredLog('info', 'payment outbox worker stopped');
  }

  isReady(): boolean { return this.ready; }

  async poll(): Promise<void> {
    if (this.activeRun !== null) return this.activeRun;
    this.activeRun = this.publishOnce().finally(() => { this.activeRun = null; });
    return this.activeRun;
  }

  private async publishOnce(): Promise<void> {
    try {
      const result = await new OutboxPublisher(this.store, {
        publish: async (record) => {
          const envelope = JSON.parse(record.payload) as { eventId?: string; correlationId?: string; aggregateId?: string };
          await this.producer.publish(record);
          structuredLog('info', 'outbox event published to Kafka', {
            eventId: envelope.eventId,
            correlationId: envelope.correlationId,
            paymentId: envelope.aggregateId,
            topic: record.topic,
          });
        },
      }).publishBatch(this.batchSize);
      if (result.published + result.retried + result.deadLettered > 0) structuredLog('info', 'outbox batch completed', result);
    } catch (error) {
      structuredLog('error', 'outbox poll failed', { error: error instanceof Error ? error.message : 'unknown error' });
    }
  }
}
