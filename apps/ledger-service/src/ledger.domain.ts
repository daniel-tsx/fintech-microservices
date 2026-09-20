export type EntryDirection = 'DEBIT' | 'CREDIT';
export type LedgerAccountType = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE';

export interface LedgerEntryInput {
  accountId: string;
  direction: EntryDirection;
  amountMinor: number;
  currency: string;
}

export interface LedgerJournal {
  id: string;
  referenceType: 'PAYMENT' | 'REFUND' | 'TRANSFER' | 'SETTLEMENT' | 'REVERSAL';
  referenceId: string;
  correlationId: string;
  reversesJournalId: string | null;
  entries: ReadonlyArray<Readonly<LedgerEntryInput & { id: string }>>;
  postedAt: string;
}

export class UnbalancedJournalError extends Error {}
export class DuplicateJournalError extends Error {}

export function assertBalanced(entries: readonly LedgerEntryInput[]): void {
  if (entries.length < 2) throw new UnbalancedJournalError('a journal requires at least two entries');
  const currencies = new Set(entries.map((entry) => entry.currency));
  if (currencies.size !== 1) throw new UnbalancedJournalError('a journal must contain exactly one currency');
  let debits = 0;
  let credits = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0) {
      throw new UnbalancedJournalError('entry amount must be a positive safe integer');
    }
    if (entry.direction === 'DEBIT') debits += entry.amountMinor;
    else credits += entry.amountMinor;
  }
  if (!Number.isSafeInteger(debits) || debits !== credits) {
    throw new UnbalancedJournalError(`journal is unbalanced: debits=${debits}, credits=${credits}`);
  }
}

export class Ledger {
  private readonly journalsByReference = new Map<string, LedgerJournal>();
  private readonly journalsById = new Map<string, LedgerJournal>();

  post(input: {
    referenceType: LedgerJournal['referenceType'];
    referenceId: string;
    correlationId: string;
    entries: LedgerEntryInput[];
    reversesJournalId?: string;
  }): LedgerJournal {
    const key = `${input.referenceType}:${input.referenceId}`;
    const duplicate = this.journalsByReference.get(key);
    if (duplicate !== undefined) return structuredClone(duplicate);
    assertBalanced(input.entries);
    if (input.reversesJournalId !== undefined && !this.journalsById.has(input.reversesJournalId)) {
      throw new Error('journal to reverse does not exist');
    }
    const journal: LedgerJournal = Object.freeze({
      id: crypto.randomUUID(),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      correlationId: input.correlationId,
      reversesJournalId: input.reversesJournalId ?? null,
      entries: Object.freeze(input.entries.map((entry) => Object.freeze({ ...entry, id: crypto.randomUUID() }))),
      postedAt: new Date().toISOString(),
    });
    this.journalsByReference.set(key, journal);
    this.journalsById.set(journal.id, journal);
    return structuredClone(journal);
  }

  reverse(journalId: string, referenceId: string, correlationId: string): LedgerJournal {
    const original = this.journalsById.get(journalId);
    if (original === undefined) throw new Error('journal to reverse does not exist');
    return this.post({
      referenceType: 'REVERSAL',
      referenceId,
      correlationId,
      reversesJournalId: journalId,
      entries: original.entries.map((entry) => ({
        accountId: entry.accountId,
        direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        amountMinor: entry.amountMinor,
        currency: entry.currency,
      })),
    });
  }

  balance(accountId: string, currency: string): number {
    let balance = 0;
    for (const journal of this.journalsById.values()) {
      for (const entry of journal.entries) {
        if (entry.accountId === accountId && entry.currency === currency) {
          balance += entry.direction === 'CREDIT' ? entry.amountMinor : -entry.amountMinor;
        }
      }
    }
    return balance;
  }

  get journals(): LedgerJournal[] {
    return Array.from(this.journalsById.values(), (journal) => structuredClone(journal));
  }
}
