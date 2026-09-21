import { describe, expect, it } from 'vitest';
import { createEvent, eventTypes, settlementCreatedEventSchema } from '@ledgerflow/contracts';
import { assertBalanced } from '../apps/ledger-service/src/ledger.domain.js';
import { settlementEntries } from '../apps/ledger-service/src/postgres-ledger.repository.js';
import { SettlementStatementSimulator, providerFee, validateStatementIntegrity, verifySettlementStatement } from '../apps/psp-simulator/src/settlement-statement.js';

const record = { externalPaymentId: '20000000-0000-4000-8000-000000000001', operationId: '20000000-0000-4000-8000-000000000002', paymentId: '20000000-0000-4000-8000-000000000003', operation: 'CAPTURE' as const, amountMinor: 10_000, currency: 'USD', status: 'SUCCEEDED' as const, providerSequence: 1, createdAt: '2026-01-01T01:00:00.000Z' };

describe('settlement statements and accounting', () => {
  it('calculates deterministic fees and a signed, internally consistent statement', () => {
    const statement = new SettlementStatementSimulator('secret', () => new Date('2026-01-02T00:00:00Z')).generate({ providerSettlementId: 'batch-1', windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-02T00:00:00Z', currency: 'USD', records: [record] });
    expect(providerFee(10_000)).toBe(300);
    expect(statement.items[0]).toMatchObject({ grossAmountMinor: 10_000, feeAmountMinor: 300, netAmountMinor: 9_700 });
    expect(validateStatementIntegrity(statement)).toEqual([]);
    expect(verifySettlementStatement('secret', statement)).toBe(true);
    expect(verifySettlementStatement('wrong', statement)).toBe(false);
  });

  it('generates deterministic duplicate and mismatch scenarios', () => {
    const simulator = new SettlementStatementSimulator('secret', () => new Date('2026-01-02T00:00:00Z'));
    const common = { providerSettlementId: 'batch-1', windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-02T00:00:00Z', currency: 'USD', records: [record] };
    expect(simulator.generate({ ...common, scenario: 'DUPLICATE_TRANSACTION' }).items).toHaveLength(2);
    expect(simulator.generate({ ...common, scenario: 'NET_MISMATCH' }).items[0]!.netAmountMinor).toBe(9_699);
  });

  it('creates a distinct balanced settlement journal shape and rejects invalid net', () => {
    const event = settlementCreatedEventSchema.parse(createEvent({ eventType: eventTypes.settlementCreated, aggregateId: crypto.randomUUID(), correlationId: crypto.randomUUID(), payload: { settlementBatchId: crypto.randomUUID(), settlementItemId: crypto.randomUUID(), providerSettlementId: 'batch-1', providerTransactionId: record.operationId, paymentId: record.paymentId, operationId: record.operationId, operationType: 'CAPTURE', grossAmountMinor: 10_000, feeAmountMinor: 300, netAmountMinor: 9_700, currency: 'USD' } }));
    const entries = settlementEntries(event.payload, { processorAccountId: crypto.randomUUID(), cashAccountId: crypto.randomUUID(), feeAccountId: crypto.randomUUID() });
    expect(() => assertBalanced(entries)).not.toThrow();
    expect(entries.map((entry) => [entry.direction, entry.amountMinor])).toEqual([['DEBIT', 9_700], ['DEBIT', 300], ['CREDIT', 10_000]]);
    expect(() => settlementEntries({ ...event.payload, netAmountMinor: 9_600 }, { processorAccountId: crypto.randomUUID(), cashAccountId: crypto.randomUUID(), feeAccountId: crypto.randomUUID() })).toThrow('gross must equal net plus provider fee');
  });
});
