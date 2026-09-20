import type { EventEnvelope, PaymentStatus } from '@ledgerflow/contracts';
import { bigint, char, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey(),
  walletId: uuid('wallet_id').notNull(),
  merchantId: uuid('merchant_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  status: text('status').$type<PaymentStatus>().notNull(),
  authorizedAmountMinor: bigint('authorized_amount_minor', { mode: 'number' }).notNull(),
  capturedAmountMinor: bigint('captured_amount_minor', { mode: 'number' }).notNull(),
  refundedAmountMinor: bigint('refunded_amount_minor', { mode: 'number' }).notNull(),
  externalPaymentId: uuid('external_payment_id'),
  failureCode: text('failure_code'),
  version: bigint('version', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, (table) => [index('payments_status_updated_idx').on(table.status, table.updatedAt)]);

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: varchar('key', { length: 255 }).primaryKey(),
  requestHash: char('request_hash', { length: 64 }).notNull(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey(),
  topic: text('topic').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  payload: jsonb('payload').$type<EventEnvelope>().notNull(),
  attempts: integer('attempts').default(0).notNull(),
  availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const inboxEvents = pgTable('inbox_events', {
  eventId: uuid('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
});

export const deadLetterEvents = pgTable('dead_letter_events', {
  eventId: uuid('event_id').primaryKey(),
  payload: jsonb('payload').notNull(),
  error: text('error').notNull(),
  failedAt: timestamp('failed_at', { withTimezone: true }).defaultNow().notNull(),
});
