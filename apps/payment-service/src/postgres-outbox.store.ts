import type { OutboxStore, PendingOutboxRecord } from '@ledgerflow/platform';
import type { PostgresClient } from './database.js';

interface ClaimedRow {
  id: string;
  topic: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
}

export class PostgresOutboxStore implements OutboxStore {
  constructor(
    private readonly client: PostgresClient,
    private readonly workerId: string,
    private readonly leaseMilliseconds = 30_000,
  ) {}

  async claimBatch(limit: number): Promise<PendingOutboxRecord[]> {
    const rows = await this.client<ClaimedRow[]>`
      WITH candidates AS (
        SELECT id
        FROM outbox_events
        WHERE published_at IS NULL
          AND dead_lettered_at IS NULL
          AND available_at <= now()
          AND (locked_at IS NULL OR locked_at < now() - (${this.leaseMilliseconds} * interval '1 millisecond'))
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE outbox_events AS event
      SET locked_at = now(), locked_by = ${this.workerId}
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id, event.topic, event.aggregate_id, event.payload, event.attempts
    `;
    return rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      key: row.aggregate_id,
      payload: JSON.stringify(row.payload),
      attempts: row.attempts,
    }));
  }

  async markPublished(id: string): Promise<void> {
    await this.client`
      UPDATE outbox_events
      SET published_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL
      WHERE id = ${id} AND locked_by = ${this.workerId}
    `;
  }

  async reschedule(id: string, availableAt: Date, error: string): Promise<void> {
    await this.client`
      UPDATE outbox_events
      SET attempts = attempts + 1, available_at = ${availableAt}, last_error = ${error}, locked_at = NULL, locked_by = NULL
      WHERE id = ${id} AND locked_by = ${this.workerId}
    `;
  }

  async moveToDeadLetter(record: PendingOutboxRecord, error: string): Promise<void> {
    await this.client.begin(async (transaction) => {
      await transaction`
        INSERT INTO dead_letter_events (event_id, payload, error)
        VALUES (${record.id}, ${record.payload}::jsonb, ${error})
        ON CONFLICT (event_id) DO NOTHING
      `;
      await transaction`
        UPDATE outbox_events
        SET attempts = attempts + 1, dead_lettered_at = now(), last_error = ${error}, locked_at = NULL, locked_by = NULL
        WHERE id = ${record.id} AND locked_by = ${this.workerId}
      `;
    });
  }
}
