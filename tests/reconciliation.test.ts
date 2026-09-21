import { describe, expect, it } from 'vitest';
import { ReconciliationService, type LedgerView, type PaymentView, type PspView } from '../apps/reconciliation-service/src/reconciliation.service.js';
import { SettlementStatementSimulator, type ProviderSettlementStatement } from '../apps/psp-simulator/src/settlement-statement.js';

const paymentId = '10000000-0000-4000-8000-000000000001';
const operationId = '10000000-0000-4000-8000-000000000002';
const walletId = '10000000-0000-4000-8000-000000000003';
const merchantId = '10000000-0000-4000-8000-000000000004';
const externalPaymentId = '10000000-0000-4000-8000-000000000005';
const now = new Date('2026-01-02T00:00:00.000Z');

function fixture(): { payments: PaymentView[]; pspRecords: PspView[]; ledgerJournals: LedgerView[]; statement: ProviderSettlementStatement } {
  const payments: PaymentView[] = [{ id: paymentId, walletId, merchantId, status: 'CAPTURED', capturedAmountMinor: 10_000, refundedAmountMinor: 0, currency: 'USD', updatedAt: '2026-01-01T01:00:00.000Z', operations: [{ id: operationId, type: 'CAPTURE', status: 'SUCCEEDED', amountMinor: 10_000, currency: 'USD', externalPaymentId }] }];
  const pspRecords: PspView[] = [{ paymentId, operationId, externalPaymentId, operation: 'CAPTURE', amountMinor: 10_000, currency: 'USD', status: 'SUCCEEDED', createdAt: '2026-01-01T01:00:00.000Z' }];
  const ledgerJournals: LedgerView[] = [{ referenceType: 'PAYMENT', referenceId: paymentId, debitTotalMinor: 10_000, creditTotalMinor: 10_000, currency: 'USD' }];
  const statement = new SettlementStatementSimulator('test-secret', () => now).generate({ providerSettlementId: 'batch-1', windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-02T00:00:00.000Z', currency: 'USD', records: [{ externalPaymentId, operationId, paymentId, operation: 'CAPTURE', amountMinor: 10_000, currency: 'USD', status: 'SUCCEEDED', providerSequence: 1, createdAt: '2026-01-01T01:00:00.000Z' }] });
  return { payments, pspRecords, ledgerJournals, statement };
}

function types(input: ReturnType<typeof fixture>): string[] {
  return new ReconciliationService().reconcileEvidence({ ...input, now, gracePeriodMs: 0 }).discrepancies.map((item) => item.type);
}

describe('five-source reconciliation', () => {
  it('matches Payment, operation, PSP, Ledger, and statement evidence', () => {
    const result = new ReconciliationService().reconcileEvidence({ ...fixture(), now, gracePeriodMs: 0 });
    expect(result.discrepancies).toEqual([]);
    expect(result.settlementCandidates).toHaveLength(1);
  });

  it('detects missing provider and Ledger evidence', () => {
    const missingProvider = fixture(); missingProvider.pspRecords = [];
    expect(types(missingProvider)).toContain('PROVIDER_TRANSACTION_MISSING');
    const missingLedger = fixture(); missingLedger.ledgerJournals = [];
    const result = new ReconciliationService().reconcileEvidence({ ...missingLedger, now, gracePeriodMs: 0 });
    expect(result.discrepancies.find((item) => item.type === 'LEDGER_ENTRY_MISSING')?.repairClassification).toBe('SAFE_AUTO_REPAIR');
    expect(result.settlementCandidates).toEqual([]);
  });

  it('detects status, amount, currency, and orphan-provider mismatches', () => {
    const status = fixture(); status.payments[0]!.status = 'CAPTURE_UNKNOWN'; status.payments[0]!.operations[0]!.status = 'UNKNOWN';
    expect(new ReconciliationService().reconcileEvidence({ ...status, now, gracePeriodMs: 0 }).discrepancies.find((item) => item.type === 'STATUS_MISMATCH')?.repairClassification).toBe('SAFE_AUTO_REPAIR');
    const amount = fixture(); amount.pspRecords[0]!.amountMinor = 9_000;
    expect(types(amount)).toContain('AMOUNT_MISMATCH');
    const currency = fixture(); currency.pspRecords[0]!.currency = 'EUR';
    expect(types(currency)).toContain('CURRENCY_MISMATCH');
    const orphan = fixture(); orphan.payments = [];
    expect(types(orphan)).toContain('INTERNAL_PAYMENT_MISSING');
  });

  it('detects statement omissions, duplicates, fee/net/gross mismatch, and unknown items', () => {
    const missing = fixture(); missing.statement.items = [];
    expect(types(missing)).toContain('SETTLEMENT_ITEM_MISSING');
    const duplicate = fixture(); duplicate.statement.items.push({ ...duplicate.statement.items[0]!, providerItemId: 'duplicate' });
    expect(types(duplicate)).toContain('DUPLICATE_SETTLEMENT_ITEM');
    const fee = fixture(); fee.statement.items[0]!.feeAmountMinor = 301;
    expect(types(fee)).toContain('SETTLEMENT_FEE_MISMATCH');
    const net = fixture(); net.statement.items[0]!.netAmountMinor = 9_600;
    expect(types(net)).toContain('SETTLEMENT_NET_MISMATCH');
    const gross = fixture(); gross.statement.items[0]!.grossAmountMinor = 9_999;
    expect(types(gross)).toContain('SETTLEMENT_GROSS_MISMATCH');
    const unknown = fixture(); unknown.statement.items.push({ ...unknown.statement.items[0]!, providerItemId: 'unknown', providerTransactionId: crypto.randomUUID(), operationId: crypto.randomUUID() });
    expect(types(unknown)).toContain('UNKNOWN_SETTLEMENT_ITEM');
  });

  it('detects missing refund provider and Ledger evidence', () => {
    const input = fixture();
    const refundId = crypto.randomUUID();
    input.payments[0]!.status = 'REFUNDED'; input.payments[0]!.refundedAmountMinor = 2_000;
    input.payments[0]!.operations.push({ id: refundId, type: 'REFUND', status: 'SUCCEEDED', amountMinor: 2_000, currency: 'USD', externalPaymentId });
    expect(types(input)).toContain('REFUND_MISSING_AT_PROVIDER');
    input.pspRecords.push({ paymentId, operationId: refundId, externalPaymentId, operation: 'REFUND', amountMinor: 2_000, currency: 'USD', status: 'SUCCEEDED', createdAt: '2026-01-01T02:00:00.000Z' });
    expect(types(input)).toContain('REFUND_LEDGER_MISSING');
  });

  it('does not flag a recent missing Ledger journal inside the grace period', () => {
    const input = fixture(); input.ledgerJournals = []; input.payments[0]!.updatedAt = '2026-01-01T23:59:59.000Z';
    expect(new ReconciliationService().reconcileEvidence({ ...input, now, gracePeriodMs: 5_000 }).discrepancies.map((item) => item.type)).not.toContain('LEDGER_ENTRY_MISSING');
  });

  it('isolates bad items in a 100-item statement instead of failing independent valid items', () => {
    const payments: PaymentView[] = []; const pspRecords: PspView[] = []; const ledgerJournals: LedgerView[] = []; const records: Array<{ externalPaymentId: string; operationId: string; paymentId: string; operation: 'CAPTURE'; amountMinor: number; currency: string; status: 'SUCCEEDED'; providerSequence: number; createdAt: string }> = [];
    for (let index = 0; index < 100; index += 1) {
      const id = crypto.randomUUID(); const operation = crypto.randomUUID(); const external = crypto.randomUUID();
      payments.push({ id, walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), status: 'CAPTURED', capturedAmountMinor: 10_000, refundedAmountMinor: 0, currency: 'USD', updatedAt: '2026-01-01T01:00:00.000Z', operations: [{ id: operation, type: 'CAPTURE', status: 'SUCCEEDED', amountMinor: 10_000, currency: 'USD', externalPaymentId: external }] });
      pspRecords.push({ paymentId: id, operationId: operation, externalPaymentId: external, operation: 'CAPTURE', amountMinor: 10_000, currency: 'USD', status: 'SUCCEEDED', createdAt: '2026-01-01T01:00:00.000Z' });
      ledgerJournals.push({ referenceType: 'PAYMENT', referenceId: id, debitTotalMinor: 10_000, creditTotalMinor: 10_000, currency: 'USD' });
      records.push({ externalPaymentId: external, operationId: operation, paymentId: id, operation: 'CAPTURE', amountMinor: 10_000, currency: 'USD', status: 'SUCCEEDED', providerSequence: index + 1, createdAt: '2026-01-01T01:00:00.000Z' });
    }
    const statement = new SettlementStatementSimulator('test-secret', () => now).generate({ providerSettlementId: 'batch-100', windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-02T00:00:00.000Z', currency: 'USD', records });
    pspRecords[0]!.amountMinor = 9_000; pspRecords[1]!.amountMinor = 9_000; pspRecords[2]!.amountMinor = 9_000;
    statement.items.push({ ...statement.items[3]!, providerItemId: `${statement.items[3]!.providerItemId}:duplicate` });
    statement.items[4]!.currency = 'INVALID';
    const result = new ReconciliationService().reconcileEvidence({ payments, pspRecords, ledgerJournals, statement, now, gracePeriodMs: 0 });
    expect(result.settlementCandidates).toHaveLength(95);
    expect(result.discrepancies.map((item) => item.type)).toEqual(expect.arrayContaining(['AMOUNT_MISMATCH', 'DUPLICATE_SETTLEMENT_ITEM', 'CURRENCY_MISMATCH']));
  });
});
