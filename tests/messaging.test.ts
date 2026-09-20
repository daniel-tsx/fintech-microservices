import { describe, expect, it } from 'vitest';
import { IdempotentConsumer, OutboxPublisher, type InboxStore, type OutboxStore, type PendingOutboxRecord } from '@ledgerflow/platform';

describe('at-least-once messaging', () => {
  it('deduplicates a delivered event', async () => {
    const seen = new Set<string>();
    const store: InboxStore = { claim: async (id) => seen.has(id) ? false : (seen.add(id), true), release: async (id) => { seen.delete(id); } };
    let effects = 0;
    const consumer = new IdempotentConsumer(store);
    expect(await consumer.handle('event-1', 'payment.captured.v1', async () => { effects += 1; })).toBe('PROCESSED');
    expect(await consumer.handle('event-1', 'payment.captured.v1', async () => { effects += 1; })).toBe('DUPLICATE');
    expect(effects).toBe(1);
  });

  it('moves a poison message to dead letter after bounded attempts', async () => {
    const record: PendingOutboxRecord = { id: 'event-2', topic: 'payments', key: 'payment-1', payload: '{}', attempts: 7 };
    let deadLettered = false;
    const store: OutboxStore = {
      claimBatch: async () => [record], markPublished: async () => undefined, reschedule: async () => undefined,
      moveToDeadLetter: async () => { deadLettered = true; },
    };
    const result = await new OutboxPublisher(store, { publish: async () => { throw new Error('poison'); } }, 8).publishBatch();
    expect(result.deadLettered).toBe(1);
    expect(deadLettered).toBe(true);
  });
});
