import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEvent, eventTypes, paymentCapturedEventSchema, paymentEventsTopic, paymentRefundedEventSchema } from '@ledgerflow/contracts';
import { KafkaMessageProducer, OutboxPublisher } from '@ledgerflow/platform';
import { Kafka, logLevel } from 'kafkajs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPaymentDatabase } from '../../apps/payment-service/src/database.js';
import { PostgresOutboxStore } from '../../apps/payment-service/src/postgres-outbox.store.js';
import { PostgresPaymentRepository } from '../../apps/payment-service/src/postgres-payment.repository.js';
import { PaymentApplication } from '../../apps/payment-service/src/payment.application.js';
import type { PspPort, RiskPort } from '../../apps/payment-service/src/payment.domain.js';
import { createLedgerDatabase } from '../../apps/ledger-service/src/database.js';
import { KafkaLedgerConsumer } from '../../apps/ledger-service/src/kafka-ledger.consumer.js';
import { PostgresLedgerRepository } from '../../apps/ledger-service/src/postgres-ledger.repository.js';
import { createPspDatabase } from '../../apps/psp-simulator/src/database.js';
import { PostgresPspRepository, type PspWebhookScheduler } from '../../apps/psp-simulator/src/postgres-psp.repository.js';
import type { WebhookEnvelope } from '../../apps/payment-service/src/payment.domain.js';

const paymentUrl = process.env.PAYMENT_TEST_DATABASE_URL ?? 'postgres://ledgerflow:ledgerflow@127.0.0.1:5432/payments';
const ledgerUrl = process.env.LEDGER_TEST_DATABASE_URL ?? 'postgres://ledgerflow:ledgerflow@127.0.0.1:5432/ledger';
const pspUrl = process.env.PSP_TEST_DATABASE_URL ?? 'postgres://ledgerflow:ledgerflow@127.0.0.1:5432/psp';
const brokers = (process.env.KAFKA_TEST_BROKERS ?? '127.0.0.1:19092').split(',');
const kafkaEnabled = process.env.SKIP_KAFKA_INTEGRATION !== '1';
const kafkaIt = kafkaEnabled ? it : it.skip;

const risk: RiskPort = { evaluate: async () => ({ decision: 'APPROVE', reasonCodes: [] }) };
const psp: PspPort = {
  authorize: async () => ({ outcome: 'SUCCEEDED', externalPaymentId: crypto.randomUUID(), providerSequence: 1 }),
  capture: async ({ externalPaymentId }) => ({ outcome: 'SUCCEEDED', externalPaymentId: externalPaymentId!, providerSequence: 2 }),
  refund: async ({ externalPaymentId }) => ({ outcome: 'SUCCEEDED', externalPaymentId: externalPaymentId!, providerSequence: 3 }),
  query: async () => ({ outcome: 'NOT_FOUND' }),
};

async function resetDatabase(url: string, migrations: string[]): Promise<void> {
  const client = postgres(url, { max: 1 });
  try {
    await client.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    for (const migration of migrations) await client.unsafe(await readFile(resolve(migration), 'utf8'));
  } finally {
    await client.end();
  }
}

async function waitFor(description: string, check: () => Promise<boolean>, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function only<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('Expected a query row');
  return row;
}

describe.sequential('durable Payment -> Kafka -> Ledger flow', () => {
  const paymentConnection = createPaymentDatabase(paymentUrl);
  const ledgerConnection = createLedgerDatabase(ledgerUrl);
  const pspConnection = createPspDatabase(pspUrl);
  const kafka = new Kafka({ clientId: 'ledgerflow-integration-setup', brokers, logLevel: logLevel.NOTHING });

  beforeAll(async () => {
    await resetDatabase(paymentUrl, ['apps/payment-service/migrations/0001_payment.sql', 'apps/payment-service/migrations/0002_outbox_leases.sql', 'apps/payment-service/migrations/0003_payment_lifecycle.sql']);
    await resetDatabase(ledgerUrl, ['apps/ledger-service/migrations/0001_ledger.sql', 'apps/ledger-service/migrations/0002_inbox_and_balance.sql']);
    await resetDatabase(pspUrl, ['apps/psp-simulator/migrations/0001_psp.sql', 'apps/psp-simulator/migrations/0002_durable_operations.sql']);
    if (kafkaEnabled) {
      const admin = kafka.admin();
      await admin.connect();
      try {
        await admin.deleteTopics({ topics: [paymentEventsTopic], timeout: 5_000 }).catch(() => undefined);
        await admin.createTopics({ waitForLeaders: true, topics: [{ topic: paymentEventsTopic, numPartitions: 3, replicationFactor: 1 }] });
      } finally {
        await admin.disconnect();
      }
    }
  });

  afterAll(async () => {
    await paymentConnection.client.end();
    await ledgerConnection.client.end();
    await pspConnection.client.end();
  });

  it('rolls back payment and outbox together when creation fails between the writes', async () => {
    const repository = new PostgresPaymentRepository(paymentConnection.db, {
      afterPaymentInsert: () => Promise.reject(new Error('intentional transaction failure')),
    });
    const app = new PaymentApplication(repository, risk, psp);
    await expect(app.create({ walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 1000, currency: 'USD' }, 'atomic-failure-key', crypto.randomUUID())).rejects.toThrow('intentional transaction failure');
    const { payment_count, outbox_count } = only(await paymentConnection.client<{ payment_count: number; outbox_count: number }[]>`
      SELECT (SELECT COUNT(*)::int FROM payments) AS payment_count,
             (SELECT COUNT(*)::int FROM outbox_events) AS outbox_count
    `);
    expect({ payment_count, outbox_count }).toEqual({ payment_count: 0, outbox_count: 0 });
  });

  it('persists payment/idempotency/outbox across a connection restart', async () => {
    const firstConnection = createPaymentDatabase(paymentUrl);
    const app = new PaymentApplication(new PostgresPaymentRepository(firstConnection.db), risk, psp);
    const input = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 2100, currency: 'USD' };
    const created = await app.create(input, 'restart-durability-key', crypto.randomUUID());
    await firstConnection.client.end();
    const secondConnection = createPaymentDatabase(paymentUrl);
    try {
      const persisted = await new PostgresPaymentRepository(secondConnection.db).findById(created.id);
      const { outbox_count } = only(await secondConnection.client<{ outbox_count: number }[]>`SELECT COUNT(*)::int AS outbox_count FROM outbox_events WHERE aggregate_id = ${created.id}`);
      expect(persisted?.id).toBe(created.id);
      expect(outbox_count).toBe(1);
    } finally {
      await secondConnection.client.end();
    }
  });

  it('persists one PSP operation and returns the original result when the same operation ID is retried after restart', async () => {
    const scheduled: WebhookEnvelope[] = [];
    const scheduler: PspWebhookScheduler = {
      deliverNow: async (webhook) => { scheduled.push(webhook); },
      enqueue: async (webhook) => { scheduled.push(webhook); },
    };
    const operationId = crypto.randomUUID();
    const input = { operationId, paymentId: crypto.randomUUID(), amountMinor: 1250, currency: 'USD' };
    const firstConnection = createPspDatabase(pspUrl);
    const first = await new PostgresPspRepository(firstConnection.db, scheduler).authorize(input);
    await firstConnection.client.end();
    const secondConnection = createPspDatabase(pspUrl);
    try {
      const replay = await new PostgresPspRepository(secondConnection.db, scheduler).authorize({ ...input, scenario: 'DECLINE' });
      expect(replay).toEqual(first);
      const { count } = only(await secondConnection.client<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM psp_operations WHERE operation_id = ${operationId}`);
      expect(count).toBe(1);
    } finally {
      await secondConnection.client.end();
    }
  });

  it('durably deduplicates a PSP webhook and atomically resolves payment, history, and outbox', async () => {
    const unknownPsp: PspPort = {
      authorize: async () => ({ outcome: 'UNKNOWN', code: 'PSP_TIMEOUT' }),
      capture: async () => ({ outcome: 'UNKNOWN', code: 'PSP_TIMEOUT' }),
      refund: async () => ({ outcome: 'UNKNOWN', code: 'PSP_TIMEOUT' }),
      query: async () => ({ outcome: 'UNKNOWN', code: 'PSP_STATUS_UNAVAILABLE' }),
    };
    const repository = new PostgresPaymentRepository(paymentConnection.db);
    const application = new PaymentApplication(repository, risk, unknownPsp);
    const request = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 2750, currency: 'USD' };
    const payment = await application.create(request, `webhook-${crypto.randomUUID()}`, crypto.randomUUID());
    expect((await application.authorize(payment.id, request.customerId, crypto.randomUUID())).status).toBe('AUTHORIZATION_UNKNOWN');
    const [operation] = await paymentConnection.client<{ id: string }[]>`SELECT id FROM payment_operations WHERE payment_id = ${payment.id} AND operation_type = 'AUTHORIZE'`;
    expect(operation).toBeDefined();
    const webhook: WebhookEnvelope = {
      eventId: crypto.randomUUID(), eventType: 'AUTHORIZED', operationId: operation!.id, operationType: 'AUTHORIZE', paymentId: payment.id,
      externalPaymentId: crypto.randomUUID(), amountMinor: request.amountMinor, currency: request.currency, providerSequence: 41, occurredAt: new Date().toISOString(),
    };
    expect(await application.ingestPspWebhook(webhook)).toBe('ACCEPTED');
    expect(await application.ingestPspWebhook(webhook)).toBe('DUPLICATE');
    const claimed = await repository.claimWebhookBatch('integration-webhook-worker', 10, 30_000);
    expect(claimed).toHaveLength(1);
    expect(await application.processPspWebhook('integration-webhook-worker', claimed[0]!, webhook.eventId)).toBe('PROCESSED');
    const result = only(await paymentConnection.client<{ status: string; webhook_count: number; history_count: number; event_count: number }[]>`
      SELECT
        (SELECT status FROM payments WHERE id = ${payment.id}) AS status,
        (SELECT COUNT(*)::int FROM webhook_events WHERE event_id = ${webhook.eventId} AND processing_status = 'PROCESSED') AS webhook_count,
        (SELECT COUNT(*)::int FROM payment_state_history WHERE payment_id = ${payment.id} AND next_status = 'AUTHORIZED') AS history_count,
        (SELECT COUNT(*)::int FROM outbox_events WHERE aggregate_id = ${payment.id} AND payload->>'eventType' = 'payment.authorized.v1') AS event_count
    `);
    expect(result).toEqual({ status: 'AUTHORIZED', webhook_count: 1, history_count: 1, event_count: 1 });
  });

  kafkaIt('publishes through Kafka and deduplicates a real duplicate in the atomic Ledger inbox transaction', async () => {
    const application = new PaymentApplication(new PostgresPaymentRepository(paymentConnection.db), risk, psp);
    const input = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 3200, currency: 'USD' };
    const payment = await application.create(input, `kafka-flow-${crypto.randomUUID()}`, crypto.randomUUID());
    await application.authorize(payment.id, input.customerId, crypto.randomUUID());
    await application.capture(payment.id, `capture-${payment.id}`, crypto.randomUUID());

    const consumer = new KafkaLedgerConsumer(brokers, new PostgresLedgerRepository(ledgerConnection.db), `ledger-integration-${crypto.randomUUID()}`);
    const producer = new KafkaMessageProducer('ledgerflow-integration-producer', brokers);
    await consumer.start();
    await producer.connect();
    try {
      const crashedWorkerStore = new PostgresOutboxStore(paymentConnection.client, 'crashed-worker', 50);
      const claimed = await crashedWorkerStore.claimBatch(100);
      expect(claimed.length).toBeGreaterThanOrEqual(3);
      for (const record of claimed) await producer.publish(record);
      // Simulated crash: Kafka accepted every message, but no row is marked published.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      const restartedStore = new PostgresOutboxStore(paymentConnection.client, 'restarted-worker', 50);
      const publication = await new OutboxPublisher(restartedStore, producer).publishBatch(100);
      expect(publication.published).toBe(claimed.length);

      await waitFor('one ledger journal', async () => {
        const { count } = only(await ledgerConnection.client<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM ledger_journals WHERE reference_id = ${payment.id}`);
        return count === 1;
      });
      const { journals, entries, inbox } = only(await ledgerConnection.client<{ journals: number; entries: number; inbox: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM ledger_journals WHERE reference_id = ${payment.id}) AS journals,
          (SELECT COUNT(*)::int FROM ledger_entries WHERE journal_id IN (SELECT id FROM ledger_journals WHERE reference_id = ${payment.id})) AS entries,
          (SELECT COUNT(*)::int FROM inbox_events WHERE event_id IN (SELECT source_event_id FROM ledger_journals WHERE reference_id = ${payment.id})) AS inbox
      `);
      expect({ journals, entries, inbox }).toEqual({ journals: 1, entries: 2, inbox: 1 });
    } finally {
      await producer.disconnect();
      await consumer.stop();
    }
  });

  it('rolls back an inbox claim when Ledger crashes before commit, then processes the redelivery once', async () => {
    const paymentId = crypto.randomUUID();
    const event = paymentCapturedEventSchema.parse(createEvent({
      eventType: eventTypes.paymentCaptured,
      aggregateId: paymentId,
      correlationId: crypto.randomUUID(),
      payload: {
        paymentId,
        walletId: crypto.randomUUID(),
        merchantId: crypto.randomUUID(),
        status: 'CAPTURED',
        amountMinor: 4500,
        currency: 'USD',
      },
    }));
    const failing = new PostgresLedgerRepository(ledgerConnection.db, { afterInboxInsert: () => Promise.reject(new Error('intentional ledger crash')) });
    await expect(failing.processPaymentCaptured(event)).rejects.toThrow('intentional ledger crash');
    const { inbox_before, journals_before } = only(await ledgerConnection.client<{ inbox_before: number; journals_before: number }[]>`
      SELECT (SELECT COUNT(*)::int FROM inbox_events WHERE event_id = ${event.eventId}) AS inbox_before,
             (SELECT COUNT(*)::int FROM ledger_journals WHERE reference_id = ${event.payload.paymentId}) AS journals_before
    `);
    expect({ inbox_before, journals_before }).toEqual({ inbox_before: 0, journals_before: 0 });
    expect(await new PostgresLedgerRepository(ledgerConnection.db).processPaymentCaptured(event)).toBe('PROCESSED');
    expect(await new PostgresLedgerRepository(ledgerConnection.db).processPaymentCaptured(event)).toBe('DUPLICATE');
  });

  it('posts a refund as one deduplicated reversal journal with balanced entries', async () => {
    const paymentId = crypto.randomUUID();
    const refundId = crypto.randomUUID();
    const merchantId = crypto.randomUUID();
    const event = paymentRefundedEventSchema.parse(createEvent({
      eventType: eventTypes.paymentRefunded,
      aggregateId: paymentId,
      correlationId: crypto.randomUUID(),
      payload: { paymentId, refundId, walletId: crypto.randomUUID(), merchantId, status: 'PARTIALLY_REFUNDED', amountMinor: 725, currency: 'USD' },
    }));
    const repository = new PostgresLedgerRepository(ledgerConnection.db);
    expect(await repository.processPaymentRefunded(event)).toBe('PROCESSED');
    expect(await repository.processPaymentRefunded(event)).toBe('DUPLICATE');
    const entries = await ledgerConnection.client<{ direction: string; amount_minor: number }[]>`
      SELECT entry.direction, entry.amount_minor::int
      FROM ledger_entries entry
      JOIN ledger_journals journal ON journal.id = entry.journal_id
      WHERE journal.reference_type = 'REFUND' AND journal.reference_id = ${refundId}
      ORDER BY entry.direction
    `;
    expect(entries).toEqual([{ direction: 'CREDIT', amount_minor: 725 }, { direction: 'DEBIT', amount_minor: 725 }]);
  });

  it('enforces the double-entry invariant in PostgreSQL at commit', async () => {
    const accountA = crypto.randomUUID();
    const accountB = crypto.randomUUID();
    await ledgerConnection.client`
      INSERT INTO ledger_accounts (id, owner_type, owner_id, account_type, currency)
      VALUES (${accountA}, 'TEST', ${crypto.randomUUID()}, 'ASSET', 'USD'),
             (${accountB}, 'TEST', ${crypto.randomUUID()}, 'LIABILITY', 'USD')
    `;
    await expect(ledgerConnection.client.begin(async (transaction) => {
      const journalId = crypto.randomUUID();
      await transaction`INSERT INTO ledger_journals (id, reference_type, reference_id, correlation_id) VALUES (${journalId}, 'PAYMENT', ${crypto.randomUUID()}, ${crypto.randomUUID()})`;
      await transaction`
        INSERT INTO ledger_entries (id, journal_id, account_id, direction, amount_minor, currency)
        VALUES (${crypto.randomUUID()}, ${journalId}, ${accountA}, 'DEBIT', 1000, 'USD'),
               (${crypto.randomUUID()}, ${journalId}, ${accountB}, 'CREDIT', 999, 'USD')
      `;
    })).rejects.toMatchObject({ code: '23514' });
  });
});
