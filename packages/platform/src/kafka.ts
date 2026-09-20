import { Kafka, logLevel, Partitioners, type Producer } from 'kafkajs';
import type { MessageProducer, PendingOutboxRecord } from './outbox.js';

export class KafkaMessageProducer implements MessageProducer {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  constructor(clientId: string, brokers: string[]) {
    this.kafka = new Kafka({ clientId, brokers, logLevel: logLevel.WARN });
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }
  connect(): Promise<void> { return this.producer.connect(); }
  disconnect(): Promise<void> { return this.producer.disconnect(); }
  async ensureTopic(topic: string): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const topics = await admin.listTopics();
      if (!topics.includes(topic)) {
        await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 3, replicationFactor: 1 }] });
      }
    } finally {
      await admin.disconnect();
    }
  }
  async publish(record: Pick<PendingOutboxRecord, 'topic' | 'key' | 'payload'>): Promise<void> {
    await this.producer.send({ topic: record.topic, acks: -1, messages: [{ key: record.key, value: record.payload }] });
  }
}
