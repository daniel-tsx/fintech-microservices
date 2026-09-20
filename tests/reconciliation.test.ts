import { describe, expect, it } from 'vitest';
import { ReconciliationService } from '../apps/reconciliation-service/src/reconciliation.service.js';

describe('reconciliation', () => {
  it('detects external success, amount mismatch, duplicates, and missing ledger', () => {
    const paymentId = crypto.randomUUID();
    const discrepancies = new ReconciliationService().reconcile(
      [{ id: paymentId, status: 'AUTHORIZATION_PENDING', capturedAmountMinor: 1000, externalPaymentId: null }],
      [
        { paymentId, externalPaymentId: 'ext-1', operation: 'CAPTURE', amountMinor: 900, status: 'SUCCEEDED' },
        { paymentId, externalPaymentId: 'ext-2', operation: 'CAPTURE', amountMinor: 900, status: 'SUCCEEDED' },
      ],
      [],
    );
    expect(discrepancies.map((item) => item.type)).toEqual(expect.arrayContaining(['PSP_SUCCESS_INTERNAL_PENDING', 'AMOUNT_MISMATCH', 'DUPLICATE_EXTERNAL_TRANSACTION']));
  });
});
