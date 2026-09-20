import { backoffDelay } from './index.js';

export interface PendingOutboxRecord {
  id: string;
  topic: string;
  key: string;
  payload: string;
  attempts: number;
}

export interface OutboxStore {
  claimBatch(limit: number): Promise<PendingOutboxRecord[]>;
  markPublished(id: string): Promise<void>;
  reschedule(id: string, availableAt: Date, error: string): Promise<void>;
  moveToDeadLetter(record: PendingOutboxRecord, error: string): Promise<void>;
}

export interface MessageProducer {
  publish(record: Pick<PendingOutboxRecord, 'topic' | 'key' | 'payload'>): Promise<void>;
}

export class OutboxPublisher {
  constructor(
    private readonly store: OutboxStore,
    private readonly producer: MessageProducer,
    private readonly maximumAttempts = 8,
  ) {}

  async publishBatch(limit = 100): Promise<{ published: number; retried: number; deadLettered: number }> {
    const records = await this.store.claimBatch(limit);
    let published = 0;
    let retried = 0;
    let deadLettered = 0;
    for (const record of records) {
      try {
        await this.producer.publish(record);
        await this.store.markPublished(record.id);
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown publisher failure';
        if (record.attempts + 1 >= this.maximumAttempts) {
          await this.store.moveToDeadLetter(record, message);
          deadLettered += 1;
        } else {
          await this.store.reschedule(record.id, new Date(Date.now() + backoffDelay(record.attempts + 1)), message);
          retried += 1;
        }
      }
    }
    return { published, retried, deadLettered };
  }
}
