import { describe, expect, it } from 'vitest';
import { Ledger, UnbalancedJournalError } from '../apps/ledger-service/src/ledger.domain.js';

describe('double-entry ledger', () => {
  it('rejects an unbalanced journal', () => {
    const ledger = new Ledger();
    expect(() => ledger.post({
      referenceType: 'PAYMENT', referenceId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
      entries: [
        { accountId: 'cash', direction: 'DEBIT', amountMinor: 1000, currency: 'USD' },
        { accountId: 'merchant', direction: 'CREDIT', amountMinor: 999, currency: 'USD' },
      ],
    })).toThrow(UnbalancedJournalError);
  });

  it('is idempotent by business reference and corrects with a reversal', () => {
    const ledger = new Ledger();
    const referenceId = crypto.randomUUID();
    const input = {
      referenceType: 'PAYMENT' as const, referenceId, correlationId: crypto.randomUUID(),
      entries: [
        { accountId: 'processor-cash', direction: 'DEBIT' as const, amountMinor: 2500, currency: 'USD' },
        { accountId: 'merchant-payable', direction: 'CREDIT' as const, amountMinor: 2500, currency: 'USD' },
      ],
    };
    const first = ledger.post(input);
    expect(ledger.post(input).id).toBe(first.id);
    const reversal = ledger.reverse(first.id, crypto.randomUUID(), crypto.randomUUID());
    expect(reversal.reversesJournalId).toBe(first.id);
    expect(ledger.balance('merchant-payable', 'USD')).toBe(0);
  });
});
