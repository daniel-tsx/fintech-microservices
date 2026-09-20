import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { MessageProducer, PendingOutboxRecord } from './outbox.js';

export class KafkaMessageProducer implements MessageProducer {
  private readonly producer: Producer;
  constructor(clientId: string, brokers: string[]) {
    this.producer = new Kafka({ clientId, brokers, logLevel: logLevel.WARN }).producer({ allowAutoTopicCreation: false });
  }
  connect(): Promise<void> { return this.producer.connect(); }
  disconnect(): Promise<void> { return this.producer.disconnect(); }
  async publish(record: Pick<PendingOutboxRecord, 'topic' | 'key' | 'payload'>): Promise<void> {
    await this.producer.send({ topic: record.topic, acks: -1, messages: [{ key: record.key, value: record.payload }] });
  }
}
