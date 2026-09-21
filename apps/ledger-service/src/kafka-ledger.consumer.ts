import { eventEnvelopeSchema, eventTypes, ledgerRepairRequestedEventSchema, paymentCapturedEventSchema, paymentEventsTopic, paymentRefundedEventSchema, repairEventsTopic, settlementCreatedEventSchema, settlementEventsTopic } from '@ledgerflow/contracts';
import { structuredLog } from '@ledgerflow/platform';
import { Kafka, logLevel, type Consumer } from 'kafkajs';
import type { PostgresLedgerRepository } from './postgres-ledger.repository.js';

export class KafkaLedgerConsumer {
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private runPromise: Promise<void> | null = null;
  private ready = false;

  constructor(
    brokers: string[],
    private readonly repository: PostgresLedgerRepository,
    private readonly groupId = 'ledgerflow-ledger-v1',
  ) {
    this.kafka = new Kafka({ clientId: 'ledgerflow-ledger', brokers, logLevel: logLevel.WARN });
    this.consumer = this.kafka.consumer({ groupId: this.groupId, allowAutoTopicCreation: false });
  }

  async start(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const topics = await admin.listTopics();
      const requiredTopics = [paymentEventsTopic, settlementEventsTopic, repairEventsTopic].filter((topic) => !topics.includes(topic));
      if (requiredTopics.length > 0) await admin.createTopics({ waitForLeaders: true, topics: requiredTopics.map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })) });
    } finally {
      await admin.disconnect();
    }
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: paymentEventsTopic, fromBeginning: true });
    await this.consumer.subscribe({ topic: settlementEventsTopic, fromBeginning: true });
    await this.consumer.subscribe({ topic: repairEventsTopic, fromBeginning: true });
    this.runPromise = this.consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        if (message.value === null) throw new Error('Kafka payment event has no value');
        const parsed = eventEnvelopeSchema.parse(JSON.parse(message.value.toString('utf8')));
        if (parsed.eventType === eventTypes.paymentCaptured) {
          const event = paymentCapturedEventSchema.parse(parsed);
          const result = await this.repository.processPaymentCaptured(event);
          structuredLog('info', result === 'DUPLICATE' ? 'duplicate payment event ignored by ledger inbox' : 'payment capture posted to ledger', {
            eventId: event.eventId,
            correlationId: event.correlationId,
            paymentId: event.payload.paymentId,
            topic,
            partition,
            offset: message.offset,
          });
        } else if (parsed.eventType === eventTypes.paymentRefunded) {
          const event = paymentRefundedEventSchema.parse(parsed);
          const result = await this.repository.processPaymentRefunded(event);
          structuredLog('info', result === 'DUPLICATE' ? 'duplicate refund event ignored by ledger inbox' : 'payment refund posted to ledger', {
            eventId: event.eventId,
            correlationId: event.correlationId,
            paymentId: event.payload.paymentId,
            refundId: event.payload.refundId,
            topic,
            partition,
            offset: message.offset,
          });
        } else if (parsed.eventType === eventTypes.settlementCreated) {
          const event = settlementCreatedEventSchema.parse(parsed);
          const result = await this.repository.processSettlementCreated(event);
          structuredLog('info', result === 'DUPLICATE' ? 'duplicate settlement event ignored' : 'settlement item posted to ledger', { eventId: event.eventId, correlationId: event.correlationId, settlementBatchId: event.payload.settlementBatchId, settlementItemId: event.payload.settlementItemId, paymentId: event.payload.paymentId, topic, partition, offset: message.offset });
        } else if (parsed.eventType === eventTypes.ledgerRepairRequested) {
          const event = ledgerRepairRequestedEventSchema.parse(parsed);
          const result = await this.repository.processLedgerRepair(event);
          structuredLog('info', result === 'DUPLICATE' ? 'duplicate ledger repair event ignored' : 'verified missing capture journal repaired', { eventId: event.eventId, correlationId: event.correlationId, discrepancyId: event.payload.discrepancyId, paymentId: event.payload.paymentId, topic, partition, offset: message.offset });
        } else {
          structuredLog('info', 'non-financial payment event acknowledged by ledger', { eventId: parsed.eventId, correlationId: parsed.correlationId, paymentId: parsed.aggregateId, eventType: parsed.eventType });
        }
        await this.consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
      },
    });
    this.runPromise.catch((error: unknown) => {
      this.ready = false;
      structuredLog('error', 'ledger Kafka consumer stopped unexpectedly', { error: error instanceof Error ? error.message : 'unknown error' });
    });
    this.ready = true;
    structuredLog('info', 'ledger Kafka consumer started', { topics: [paymentEventsTopic, settlementEventsTopic, repairEventsTopic], groupId: this.groupId });
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.consumer.disconnect();
    await this.runPromise;
    structuredLog('info', 'ledger Kafka consumer stopped');
  }

  isReady(): boolean { return this.ready; }
}
