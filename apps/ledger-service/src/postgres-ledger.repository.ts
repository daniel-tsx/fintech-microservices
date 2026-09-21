import type { LedgerRepairRequestedEvent, PaymentCapturedEvent, PaymentRefundedEvent, SettlementCreatedEvent } from '@ledgerflow/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { assertBalanced, type LedgerEntryInput, type LedgerJournal } from './ledger.domain.js';
import { inboxEvents, ledgerAccounts, ledgerEntries, ledgerJournals } from './database.schema.js';
import type { LedgerDatabase } from './database.js';

const PROCESSOR_OWNER_ID = '00000000-0000-0000-0000-000000000001';
const SETTLED_CASH_OWNER_ID = '00000000-0000-0000-0000-000000000002';
const PROVIDER_FEE_OWNER_ID = '00000000-0000-0000-0000-000000000003';

export interface LedgerTransactionProbe {
  afterInboxInsert?(): Promise<void>;
}

export function settlementEntries(payload: SettlementCreatedEvent['payload'], accounts: { processorAccountId: string; cashAccountId: string; feeAccountId?: string }): LedgerEntryInput[] {
  if (payload.operationType === 'REFUND') {
    if (payload.feeAmountMinor !== 0 || payload.netAmountMinor !== -payload.grossAmountMinor) throw new Error('refund settlement must have zero fee and negative gross net');
    return [
      { accountId: accounts.processorAccountId, direction: 'DEBIT', amountMinor: payload.grossAmountMinor, currency: payload.currency },
      { accountId: accounts.cashAccountId, direction: 'CREDIT', amountMinor: payload.grossAmountMinor, currency: payload.currency },
    ];
  }
  if (payload.netAmountMinor + payload.feeAmountMinor !== payload.grossAmountMinor) throw new Error('settlement gross must equal net plus provider fee');
  if (payload.netAmountMinor <= 0) throw new Error('capture settlement net must be positive');
  if (payload.feeAmountMinor > 0 && accounts.feeAccountId === undefined) throw new Error('provider fee account is required');
  return [
    { accountId: accounts.cashAccountId, direction: 'DEBIT', amountMinor: payload.netAmountMinor, currency: payload.currency },
    ...(payload.feeAmountMinor === 0 ? [] : [{ accountId: accounts.feeAccountId!, direction: 'DEBIT' as const, amountMinor: payload.feeAmountMinor, currency: payload.currency }]),
    { accountId: accounts.processorAccountId, direction: 'CREDIT', amountMinor: payload.grossAmountMinor, currency: payload.currency },
  ];
}

export class PostgresLedgerRepository {
  constructor(private readonly db: LedgerDatabase, private readonly probe: LedgerTransactionProbe = {}) {}

  async processPaymentCaptured(event: PaymentCapturedEvent): Promise<'PROCESSED' | 'DUPLICATE'> {
    return this.processFinancialEvent(event, 'PAYMENT', event.payload.paymentId, false);
  }

  async processPaymentRefunded(event: PaymentRefundedEvent): Promise<'PROCESSED' | 'DUPLICATE'> {
    return this.processFinancialEvent(event, 'REFUND', event.payload.refundId, true);
  }

  async processLedgerRepair(event: LedgerRepairRequestedEvent): Promise<'PROCESSED' | 'DUPLICATE'> {
    return this.processFinancialEvent(event, 'PAYMENT', event.payload.paymentId, false);
  }

  async processSettlementCreated(event: SettlementCreatedEvent): Promise<'PROCESSED' | 'DUPLICATE'> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.insert(inboxEvents).values({ eventId: event.eventId, eventType: event.eventType, correlationId: event.correlationId }).onConflictDoNothing().returning({ eventId: inboxEvents.eventId });
      if (claimed.length === 0) return 'DUPLICATE';
      await this.probe.afterInboxInsert?.();
      const [existing] = await tx.select({ id: ledgerJournals.id }).from(ledgerJournals).where(and(eq(ledgerJournals.referenceType, 'SETTLEMENT'), eq(ledgerJournals.referenceId, event.payload.settlementItemId))).limit(1);
      if (existing !== undefined) return 'DUPLICATE';
      const processorAccountId = await this.ensureAccount(tx, 'PLATFORM', PROCESSOR_OWNER_ID, 'ASSET', event.payload.currency);
      const cashAccountId = await this.ensureAccount(tx, 'PLATFORM', SETTLED_CASH_OWNER_ID, 'ASSET', event.payload.currency);
      const feeAccountId = event.payload.feeAmountMinor > 0 ? await this.ensureAccount(tx, 'PLATFORM', PROVIDER_FEE_OWNER_ID, 'EXPENSE', event.payload.currency) : undefined;
      const entries = settlementEntries(event.payload, { processorAccountId, cashAccountId, ...(feeAccountId === undefined ? {} : { feeAccountId }) });
      assertBalanced(entries);
      const journalId = crypto.randomUUID();
      await tx.insert(ledgerJournals).values({ id: journalId, referenceType: 'SETTLEMENT', referenceId: event.payload.settlementItemId, correlationId: event.correlationId, sourceEventId: event.eventId });
      await tx.insert(ledgerEntries).values(entries.map((entry) => ({ id: crypto.randomUUID(), journalId, ...entry })));
      return 'PROCESSED';
    });
  }

  private async processFinancialEvent(
    event: PaymentCapturedEvent | PaymentRefundedEvent | LedgerRepairRequestedEvent,
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

      const [existingJournal] = await tx.select({ id: ledgerJournals.id }).from(ledgerJournals).where(and(eq(ledgerJournals.referenceType, referenceType), eq(ledgerJournals.referenceId, referenceId))).limit(1);
      if (existingJournal !== undefined) return 'DUPLICATE';

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

  async listForReconciliation(windowStart: Date, windowEnd: Date, afterId: string | undefined, limit: number): Promise<Array<{ id: string; referenceType: 'PAYMENT' | 'REFUND' | 'SETTLEMENT'; referenceId: string; debitTotalMinor: number; creditTotalMinor: number; currency: string }>> {
    const cursorClause = afterId === undefined ? sql`` : sql`AND j.id > ${afterId}`;
    const rows = await this.db.execute(sql`
      SELECT j.id, j.reference_type, j.reference_id,
        SUM(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT')::bigint AS debit_total_minor,
        SUM(e.amount_minor) FILTER (WHERE e.direction = 'CREDIT')::bigint AS credit_total_minor,
        MIN(e.currency) AS currency
      FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id
      WHERE j.posted_at >= ${windowStart} AND j.posted_at < ${windowEnd} ${cursorClause}
      GROUP BY j.id ORDER BY j.id LIMIT ${limit}
    `);
    return Array.from(rows as unknown as Array<{ id: string; reference_type: 'PAYMENT' | 'REFUND' | 'SETTLEMENT'; reference_id: string; debit_total_minor: number; credit_total_minor: number; currency: string }>).map((row) => ({ id: row.id, referenceType: row.reference_type, referenceId: row.reference_id, debitTotalMinor: Number(row.debit_total_minor), creditTotalMinor: Number(row.credit_total_minor), currency: row.currency }));
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
