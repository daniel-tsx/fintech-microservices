import { bigint, char, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: uuid('id').primaryKey(),
  ownerType: text('owner_type').notNull(),
  ownerId: uuid('owner_id').notNull(),
  accountType: text('account_type').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('ledger_accounts_owner_type_idx').on(table.ownerType, table.ownerId, table.accountType, table.currency)]);

export const ledgerJournals = pgTable('ledger_journals', {
  id: uuid('id').primaryKey(),
  referenceType: text('reference_type').notNull(),
  referenceId: uuid('reference_id').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  sourceEventId: uuid('source_event_id').unique(),
  reversesJournalId: uuid('reverses_journal_id'),
  postedAt: timestamp('posted_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('ledger_journals_reference_idx').on(table.referenceType, table.referenceId)]);

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey(),
  journalId: uuid('journal_id').notNull().references(() => ledgerJournals.id),
  accountId: uuid('account_id').notNull().references(() => ledgerAccounts.id),
  direction: text('direction').$type<'DEBIT' | 'CREDIT'>().notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('ledger_entries_account_time_idx').on(table.accountId, table.createdAt)]);

export const inboxEvents = pgTable('inbox_events', {
  eventId: uuid('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
});
