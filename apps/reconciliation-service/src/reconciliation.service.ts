export type DiscrepancyType =
  | 'PSP_SUCCESS_INTERNAL_PENDING'
  | 'INTERNAL_CAPTURE_MISSING_AT_PSP'
  | 'AMOUNT_MISMATCH'
  | 'DUPLICATE_EXTERNAL_TRANSACTION'
  | 'MISSING_LEDGER_JOURNAL';

export interface ReconciliationDiscrepancy {
  id: string;
  paymentId: string;
  type: DiscrepancyType;
  expected: unknown;
  actual: unknown;
  status: 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED';
  detectedAt: string;
}

interface PaymentView { id: string; status: string; capturedAmountMinor: number; externalPaymentId: string | null }
interface PspView { paymentId: string; externalPaymentId: string; operation: string; amountMinor: number; status: string }
interface LedgerView { referenceId: string; amountMinor: number }

export class ReconciliationService {
  reconcile(payments: PaymentView[], pspRecords: PspView[], ledgerJournals: LedgerView[]): ReconciliationDiscrepancy[] {
    const discrepancies: ReconciliationDiscrepancy[] = [];
    const pspCaptures = pspRecords.filter((record) => record.operation === 'CAPTURE' && record.status === 'SUCCEEDED');
    const byPayment = new Map<string, PspView[]>();
    for (const record of pspCaptures) byPayment.set(record.paymentId, [...(byPayment.get(record.paymentId) ?? []), record]);
    for (const payment of payments) {
      const external = byPayment.get(payment.id) ?? [];
      if (external.length > 0 && payment.status !== 'CAPTURED' && payment.status !== 'REFUNDED') {
        discrepancies.push(this.issue(payment.id, 'PSP_SUCCESS_INTERNAL_PENDING', payment.status, external[0]?.status));
      }
      if (payment.status === 'CAPTURED' && external.length === 0) discrepancies.push(this.issue(payment.id, 'INTERNAL_CAPTURE_MISSING_AT_PSP', payment.capturedAmountMinor, null));
      if (external.some((record) => record.amountMinor !== payment.capturedAmountMinor)) discrepancies.push(this.issue(payment.id, 'AMOUNT_MISMATCH', payment.capturedAmountMinor, external.map((record) => record.amountMinor)));
      if (new Set(external.map((record) => record.externalPaymentId)).size > 1) discrepancies.push(this.issue(payment.id, 'DUPLICATE_EXTERNAL_TRANSACTION', 1, external.length));
      if (payment.status === 'CAPTURED' && !ledgerJournals.some((journal) => journal.referenceId === payment.id && journal.amountMinor === payment.capturedAmountMinor)) {
        discrepancies.push(this.issue(payment.id, 'MISSING_LEDGER_JOURNAL', payment.capturedAmountMinor, null));
      }
    }
    return discrepancies;
  }

  private issue(paymentId: string, type: DiscrepancyType, expected: unknown, actual: unknown): ReconciliationDiscrepancy {
    return { id: crypto.randomUUID(), paymentId, type, expected, actual, status: 'OPEN', detectedAt: new Date().toISOString() };
  }
}
