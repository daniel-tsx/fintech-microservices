import type { PspScenario } from '@ledgerflow/contracts';
import type { PaymentOperationType, WebhookEnvelope } from '../../payment-service/src/payment.domain.js';
import { bigint, bigserial, char, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const pspOperations = pgTable('psp_operations', {
  id: uuid('id').primaryKey(),
  intentKey: text('intent_key').notNull(),
  operationId: uuid('operation_id').notNull(),
  externalPaymentId: uuid('external_payment_id').notNull(),
  internalPaymentId: uuid('internal_payment_id').notNull(),
  operation: text('operation').$type<PaymentOperationType>().notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  status: text('status').$type<'SUCCEEDED' | 'DECLINED'>().notNull(),
  providerSequence: bigserial('provider_sequence', { mode: 'number' }).notNull(),
  scenario: text('scenario').$type<PspScenario>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('psp_operations_operation_id_idx').on(table.operationId)]);

export const pendingWebhooks = pgTable('pending_webhooks', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id'),
  eventType: text('event_type').notNull(),
  operationId: uuid('operation_id'),
  paymentId: uuid('payment_id'),
  providerSequence: bigint('provider_sequence', { mode: 'number' }),
  payload: jsonb('payload').$type<WebhookEnvelope>().notNull(),
  deliverAfter: timestamp('deliver_after', { withTimezone: true }).notNull(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, (table) => [index('pending_webhooks_delivery_idx').on(table.deliverAfter, table.attemptCount)]);

export const pspSettlementStatements = pgTable('psp_settlement_statements', {
  providerSettlementId: text('provider_settlement_id').primaryKey(),
  statement: jsonb('statement').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
