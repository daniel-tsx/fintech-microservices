import type { PaymentCapturedEvent, PaymentRefundedEvent } from '@ledgerflow/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { assertBalanced, type LedgerEntryInput, type LedgerJournal } from './ledger.domain.js';
import { inboxEvents, ledgerAccounts, ledgerEntries, ledgerJournals } from './database.schema.js';
import type { LedgerDatabase } from './database.js';

const PROCESSOR_OWNER_ID = '00000000-0000-0000-0000-000000000001';

export interface LedgerTransactionProbe {
  afterInboxInsert?(): Promise<void>;
}

export class PostgresLedgerRepository {
  constructor(private readonly db: LedgerDatabase, private readonly probe: LedgerTransactionProbe = {}) {}

  async processPaymentCaptured(event: PaymentCapturedEvent): Promise<'PROCESSED' | 'DUPLICATE'> {
    return this.processFinancialEvent(event, 'PAYMENT', event.payload.paymentId, false);
  }

  async processPaymentRefunded(event: PaymentRefundedEvent): Promise<'PROCESSED' | 'DUPLICATE'> {
    return this.processFinancialEvent(event, 'REFUND', event.payload.refundId, true);
  }

  private async processFinancialEvent(
    event: PaymentCapturedEvent | PaymentRefundedEvent,
    referenceType: 'PAYMENT' | 'REFUND',
    referenceId: string,
    reverse: boolean,
  ): Promise<'PROCESSED' | 'DUPLICATE'> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.insert(inboxEvents).values({
        eventId: event.eventId,
        eventType: event.eventType,
        correlationId: event.correlationId,
      }).onConflictDoNothing().returning({ eventId: inboxEvents.eventId });
      if (claimed.length === 0) return 'DUPLICATE';
      await this.probe.afterInboxInsert?.();

      const processorAccountId = await this.ensureAccount(tx, 'PLATFORM', PROCESSOR_OWNER_ID, 'ASSET', event.payload.currency);
      const merchantAccountId = await this.ensureAccount(tx, 'MERCHANT', event.payload.merchantId, 'LIABILITY', event.payload.currency);
      const entries: LedgerEntryInput[] = [
        { accountId: processorAccountId, direction: reverse ? 'CREDIT' : 'DEBIT', amountMinor: event.payload.amountMinor, currency: event.payload.currency },
        { accountId: merchantAccountId, direction: reverse ? 'DEBIT' : 'CREDIT', amountMinor: event.payload.amountMinor, currency: event.payload.currency },
      ];
      assertBalanced(entries);
      const journalId = crypto.randomUUID();
      const [capturedJournal] = reverse
        ? await tx.select({ id: ledgerJournals.id }).from(ledgerJournals).where(and(eq(ledgerJournals.referenceType, 'PAYMENT'), eq(ledgerJournals.referenceId, event.payload.paymentId))).limit(1)
        : [];
      await tx.insert(ledgerJournals).values({
        id: journalId,
        referenceType,
        referenceId,
        correlationId: event.correlationId,
        sourceEventId: event.eventId,
        ...(capturedJournal === undefined ? {} : { reversesJournalId: capturedJournal.id }),
      });
      await tx.insert(ledgerEntries).values(entries.map((entry) => ({ id: crypto.randomUUID(), journalId, ...entry })));
      return 'PROCESSED';
    });
  }

  async postJournal(input: {
    referenceType: LedgerJournal['referenceType'];
    referenceId: string;
    correlationId: string;
    entries: LedgerEntryInput[];
  }): Promise<LedgerJournal> {
    assertBalanced(input.entries);
    return this.db.transaction(async (tx) => {
      const journalId = crypto.randomUUID();
      const postedAt = new Date();
      const entries = input.entries.map((entry) => ({ ...entry, id: crypto.randomUUID() }));
      await tx.insert(ledgerJournals).values({ id: journalId, referenceType: input.referenceType, referenceId: input.referenceId, correlationId: input.correlationId, postedAt });
      await tx.insert(ledgerEntries).values(entries.map((entry) => ({ ...entry, journalId })));
      return {
        id: journalId,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        correlationId: input.correlationId,
        reversesJournalId: null,
        entries,
        postedAt: postedAt.toISOString(),
      };
    });
  }

  async balance(accountId: string, currency: string): Promise<number> {
    const [row] = await this.db.select({
      balance: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.direction} = 'CREDIT' THEN ${ledgerEntries.amountMinor} ELSE -${ledgerEntries.amountMinor} END), 0)::bigint`,
    }).from(ledgerEntries).where(and(eq(ledgerEntries.accountId, accountId), eq(ledgerEntries.currency, currency)));
    return Number(row?.balance ?? 0);
  }

  private async ensureAccount(
    tx: Parameters<Parameters<LedgerDatabase['transaction']>[0]>[0],
    ownerType: string,
    ownerId: string,
    accountType: string,
    currency: string,
  ): Promise<string> {
    const inserted = await tx.insert(ledgerAccounts).values({ id: crypto.randomUUID(), ownerType, ownerId, accountType, currency })
      .onConflictDoNothing({ target: [ledgerAccounts.ownerType, ledgerAccounts.ownerId, ledgerAccounts.accountType, ledgerAccounts.currency] })
      .returning({ id: ledgerAccounts.id });
    if (inserted[0] !== undefined) return inserted[0].id;
    const [existing] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(
      eq(ledgerAccounts.ownerType, ownerType),
      eq(ledgerAccounts.ownerId, ownerId),
      eq(ledgerAccounts.accountType, accountType),
      eq(ledgerAccounts.currency, currency),
    )).limit(1);
    if (existing === undefined) throw new Error('ledger account upsert did not return an account');
    return existing.id;
  }
}
