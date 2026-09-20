import type { EventEnvelope, PaymentStatus } from '@ledgerflow/contracts';
import type { PaymentOperationStatus, PaymentOperationType, ResolutionSource, WebhookEnvelope } from './payment.domain.js';
import { bigint, char, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey(),
  walletId: uuid('wallet_id').notNull(),
  merchantId: uuid('merchant_id').notNull(),
  customerId: uuid('customer_id'),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  status: text('status').$type<PaymentStatus>().notNull(),
  authorizedAmountMinor: bigint('authorized_amount_minor', { mode: 'number' }).notNull(),
  capturedAmountMinor: bigint('captured_amount_minor', { mode: 'number' }).notNull(),
  refundedAmountMinor: bigint('refunded_amount_minor', { mode: 'number' }).notNull(),
  externalPaymentId: uuid('external_payment_id'),
  providerSequence: bigint('provider_sequence', { mode: 'number' }).default(0).notNull(),
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

export const paymentOperations = pgTable('payment_operations', {
  id: uuid('id').primaryKey(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  operationType: text('operation_type').$type<PaymentOperationType>().notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
  requestHash: char('request_hash', { length: 64 }).notNull(),
  status: text('status').$type<PaymentOperationStatus>().notNull(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  externalPaymentId: uuid('external_payment_id'),
  providerSequence: bigint('provider_sequence', { mode: 'number' }),
  failureCode: text('failure_code'),
  resolutionSource: text('resolution_source').$type<ResolutionSource>(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('payment_operations_idempotency_idx').on(table.idempotencyKey),
  index('payment_operations_recovery_idx').on(table.status, table.updatedAt),
]);

export const paymentStateHistory = pgTable('payment_state_history', {
  id: uuid('id').primaryKey(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  previousStatus: text('previous_status').$type<PaymentStatus>(),
  nextStatus: text('next_status').$type<PaymentStatus>().notNull(),
  source: text('source').notNull(),
  operationId: uuid('operation_id'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('payment_state_history_payment_idx').on(table.paymentId, table.createdAt)]);

export const webhookEvents = pgTable('webhook_events', {
  eventId: uuid('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  operationId: uuid('operation_id').notNull(),
  paymentId: uuid('payment_id').notNull(),
  providerSequence: bigint('provider_sequence', { mode: 'number' }).notNull(),
  payload: jsonb('payload').$type<WebhookEnvelope>().notNull(),
  processingStatus: text('processing_status').$type<'PENDING' | 'PROCESSED' | 'IGNORED'>().default('PENDING').notNull(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => [index('webhook_events_pending_idx').on(table.processingStatus, table.receivedAt)]);
