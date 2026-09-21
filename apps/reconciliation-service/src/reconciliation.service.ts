import { createHash } from 'node:crypto';
import type { ProviderSettlementItem, ProviderSettlementStatement } from '../../psp-simulator/src/settlement-statement.js';

export const discrepancyTypes = [
  'PROVIDER_TRANSACTION_MISSING',
  'INTERNAL_PAYMENT_MISSING',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'STATUS_MISMATCH',
  'LEDGER_ENTRY_MISSING',
  'LEDGER_AMOUNT_MISMATCH',
  'SETTLEMENT_ITEM_MISSING',
  'UNKNOWN_SETTLEMENT_ITEM',
  'DUPLICATE_SETTLEMENT_ITEM',
  'SETTLEMENT_GROSS_MISMATCH',
  'SETTLEMENT_FEE_MISMATCH',
  'SETTLEMENT_NET_MISMATCH',
  'REFUND_MISSING_AT_PROVIDER',
  'REFUND_LEDGER_MISSING',
  'STATEMENT_INTEGRITY_FAILED',
] as const;

export type DiscrepancyType = (typeof discrepancyTypes)[number];
export type DiscrepancySeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type RepairClassification = 'SAFE_AUTO_REPAIR' | 'REQUIRES_REVIEW';

export interface PaymentOperationView {
  id: string;
  type: 'AUTHORIZE' | 'CAPTURE' | 'REFUND';
  status: 'PENDING' | 'SUCCEEDED' | 'DECLINED' | 'FAILED' | 'UNKNOWN';
  amountMinor: number;
  currency: string;
  externalPaymentId: string | null;
}

export interface PaymentView {
  id: string;
  walletId: string;
  merchantId: string;
  status: string;
  capturedAmountMinor: number;
  refundedAmountMinor: number;
  currency: string;
  updatedAt: string;
  operations: PaymentOperationView[];
}

export interface PspView {
  paymentId: string;
  operationId: string;
  externalPaymentId: string;
  operation: 'AUTHORIZE' | 'CAPTURE' | 'REFUND';
  amountMinor: number;
  currency: string;
  status: 'SUCCEEDED' | 'DECLINED';
  createdAt: string;
}

export interface LedgerView {
  referenceType: 'PAYMENT' | 'REFUND' | 'SETTLEMENT';
  referenceId: string;
  debitTotalMinor: number;
  creditTotalMinor: number;
  currency: string;
}

export interface ReconciliationDiscrepancy {
  fingerprint: string;
  paymentId: string | null;
  providerTransactionId: string | null;
  settlementItemId: string | null;
  type: DiscrepancyType;
  severity: DiscrepancySeverity;
  repairClassification: RepairClassification;
  expected: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
}

export interface ReconciliationResult {
  matched: number;
  discrepancies: ReconciliationDiscrepancy[];
  settlementCandidates: Array<{ payment: PaymentView; operation: PaymentOperationView; item: ProviderSettlementItem }>;
}

export interface ReconciliationEvidence {
  payments: PaymentView[];
  pspRecords: PspView[];
  ledgerJournals: LedgerView[];
  statement?: ProviderSettlementStatement;
  gracePeriodMs?: number;
  now?: Date;
}

function fingerprint(type: DiscrepancyType, paymentId: string | null, providerTransactionId: string | null, settlementItemId: string | null): string {
  return createHash('sha256').update([type, paymentId ?? '-', providerTransactionId ?? '-', settlementItemId ?? '-'].join('|')).digest('hex');
}

function classification(type: DiscrepancyType, context: { payment?: PaymentView; psp?: PspView }): RepairClassification {
  if (type === 'LEDGER_ENTRY_MISSING') return 'SAFE_AUTO_REPAIR';
  if (type === 'STATUS_MISMATCH'
    && context.payment !== undefined
    && ['CAPTURE_PENDING', 'CAPTURE_UNKNOWN'].includes(context.payment.status)
    && context.psp?.status === 'SUCCEEDED') return 'SAFE_AUTO_REPAIR';
  return 'REQUIRES_REVIEW';
}

function severity(type: DiscrepancyType): DiscrepancySeverity {
  return ['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'INTERNAL_PAYMENT_MISSING', 'DUPLICATE_SETTLEMENT_ITEM', 'STATEMENT_INTEGRITY_FAILED'].includes(type) ? 'CRITICAL' : 'WARNING';
}

export class ReconciliationService {
  reconcileEvidence(evidence: ReconciliationEvidence): ReconciliationResult {
    const discrepancies: ReconciliationDiscrepancy[] = [];
    const candidates: ReconciliationResult['settlementCandidates'] = [];
    const paymentsById = new Map(evidence.payments.map((payment) => [payment.id, payment]));
    const pspByOperation = new Map(evidence.pspRecords.map((record) => [record.operationId, record]));
    const ledgerByReference = new Map(evidence.ledgerJournals.map((journal) => [`${journal.referenceType}:${journal.referenceId}`, journal]));
    const statementItems = evidence.statement?.items ?? [];
    const settlementByTransaction = new Map<string, ProviderSettlementItem[]>();
    for (const item of statementItems) settlementByTransaction.set(item.providerTransactionId, [...(settlementByTransaction.get(item.providerTransactionId) ?? []), item]);
    const now = (evidence.now ?? new Date()).getTime();
    const gracePeriodMs = evidence.gracePeriodMs ?? 30_000;

    const issue = (type: DiscrepancyType, input: { payment?: PaymentView; psp?: PspView; item?: ProviderSettlementItem; expected?: Record<string, unknown>; actual?: Record<string, unknown> }) => {
      const paymentId = input.payment?.id ?? input.psp?.paymentId ?? (input.item?.merchantReference ?? null);
      const providerTransactionId = input.psp?.operationId ?? input.item?.providerTransactionId ?? null;
      const settlementItemId = input.item?.providerItemId ?? null;
      discrepancies.push({
        fingerprint: fingerprint(type, paymentId, providerTransactionId, settlementItemId),
        paymentId,
        providerTransactionId,
        settlementItemId,
        type,
        severity: severity(type),
        repairClassification: classification(type, input),
        expected: input.expected ?? null,
        actual: input.actual ?? null,
      });
    };

    for (const payment of evidence.payments) {
      const operations = payment.operations.filter((operation) => operation.type === 'CAPTURE' || operation.type === 'REFUND');
      for (const operation of operations) {
        const psp = pspByOperation.get(operation.id);
        const isCapture = operation.type === 'CAPTURE';
        if (psp === undefined) {
          if (operation.status === 'SUCCEEDED') issue(isCapture ? 'PROVIDER_TRANSACTION_MISSING' : 'REFUND_MISSING_AT_PROVIDER', { payment, expected: { operationId: operation.id, status: 'SUCCEEDED' }, actual: { status: 'MISSING' } });
          continue;
        }
        if (psp.paymentId !== payment.id) issue('INTERNAL_PAYMENT_MISSING', { psp, actual: { paymentId: psp.paymentId }, expected: { paymentId: payment.id } });
        if (psp.amountMinor !== operation.amountMinor) issue('AMOUNT_MISMATCH', { payment, psp, expected: { amountMinor: operation.amountMinor }, actual: { amountMinor: psp.amountMinor } });
        if (psp.currency !== operation.currency) issue('CURRENCY_MISMATCH', { payment, psp, expected: { currency: operation.currency }, actual: { currency: psp.currency } });
        if (psp.status === 'SUCCEEDED' && operation.status !== 'SUCCEEDED') issue('STATUS_MISMATCH', { payment, psp, expected: { operationStatus: 'SUCCEEDED' }, actual: { operationStatus: operation.status, paymentStatus: payment.status } });

        if (operation.status === 'SUCCEEDED') {
          const ledgerType = isCapture ? 'PAYMENT' : 'REFUND';
          const referenceId = isCapture ? payment.id : operation.id;
          const ledger = ledgerByReference.get(`${ledgerType}:${referenceId}`);
          const outsideGrace = now - Date.parse(payment.updatedAt) >= gracePeriodMs;
          if (ledger === undefined && outsideGrace) issue(isCapture ? 'LEDGER_ENTRY_MISSING' : 'REFUND_LEDGER_MISSING', { payment, psp, expected: { referenceType: ledgerType, referenceId, amountMinor: operation.amountMinor, currency: operation.currency, walletId: payment.walletId, merchantId: payment.merchantId }, actual: { journal: 'MISSING' } });
          else if (ledger !== undefined && (ledger.debitTotalMinor !== operation.amountMinor || ledger.creditTotalMinor !== operation.amountMinor)) issue('LEDGER_AMOUNT_MISMATCH', { payment, psp, expected: { amountMinor: operation.amountMinor }, actual: { debitTotalMinor: ledger.debitTotalMinor, creditTotalMinor: ledger.creditTotalMinor } });
        }

        if (psp.status === 'SUCCEEDED' && evidence.statement !== undefined) {
          const items = settlementByTransaction.get(psp.operationId) ?? [];
          if (items.length === 0) issue('SETTLEMENT_ITEM_MISSING', { payment, psp, expected: { providerTransactionId: psp.operationId }, actual: { settlementItem: 'MISSING' } });
          if (items.length > 1 && items[0] !== undefined) issue('DUPLICATE_SETTLEMENT_ITEM', { payment, psp, item: items[0], expected: { count: 1 }, actual: { count: items.length } });
          const item = items[0];
          if (item !== undefined) {
            const expectedFee = operation.type === 'CAPTURE' ? Math.floor((operation.amountMinor * 300) / 10_000) : 0;
            const expectedNet = operation.type === 'CAPTURE' ? operation.amountMinor - expectedFee : -operation.amountMinor;
            if (item.grossAmountMinor !== operation.amountMinor) issue('SETTLEMENT_GROSS_MISMATCH', { payment, psp, item, expected: { grossAmountMinor: operation.amountMinor }, actual: { grossAmountMinor: item.grossAmountMinor } });
            if (item.feeAmountMinor !== expectedFee) issue('SETTLEMENT_FEE_MISMATCH', { payment, psp, item, expected: { feeAmountMinor: expectedFee }, actual: { feeAmountMinor: item.feeAmountMinor } });
            if (item.netAmountMinor !== expectedNet) issue('SETTLEMENT_NET_MISMATCH', { payment, psp, item, expected: { netAmountMinor: expectedNet }, actual: { netAmountMinor: item.netAmountMinor } });
            if (item.currency !== operation.currency) issue('CURRENCY_MISMATCH', { payment, psp, item, expected: { currency: operation.currency }, actual: { settlementCurrency: item.currency } });
            if (item.providerStatus !== 'SETTLED') issue('STATUS_MISMATCH', { payment, psp, item, expected: { settlementStatus: 'SETTLED' }, actual: { settlementStatus: item.providerStatus } });
            if (item.settlementBatchId !== evidence.statement.providerSettlementId) issue('STATEMENT_INTEGRITY_FAILED', { payment, psp, item, expected: { settlementBatchId: evidence.statement.providerSettlementId }, actual: { settlementBatchId: item.settlementBatchId } });
            const hasBlockingMismatch = discrepancies.some((value) => value.providerTransactionId === psp.operationId && ['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'STATUS_MISMATCH', 'LEDGER_ENTRY_MISSING', 'REFUND_LEDGER_MISSING', 'LEDGER_AMOUNT_MISMATCH', 'DUPLICATE_SETTLEMENT_ITEM', 'SETTLEMENT_GROSS_MISMATCH', 'SETTLEMENT_FEE_MISMATCH', 'SETTLEMENT_NET_MISMATCH', 'STATEMENT_INTEGRITY_FAILED'].includes(value.type));
            if (!hasBlockingMismatch && item.providerStatus === 'SETTLED') candidates.push({ payment, operation, item });
          }
        }
      }
    }

    for (const psp of evidence.pspRecords.filter((record) => record.status === 'SUCCEEDED' && (record.operation === 'CAPTURE' || record.operation === 'REFUND'))) {
      if (!paymentsById.has(psp.paymentId)) issue('INTERNAL_PAYMENT_MISSING', { psp, expected: { paymentId: psp.paymentId }, actual: { payment: 'MISSING' } });
    }
    for (const item of statementItems) {
      if (!pspByOperation.has(item.providerTransactionId)) issue('UNKNOWN_SETTLEMENT_ITEM', { item, expected: { providerTransaction: 'KNOWN' }, actual: { providerTransaction: 'MISSING' } });
    }
    const observedKeys = new Set(discrepancies.map((item) => `${item.type}:${item.providerTransactionId ?? item.paymentId}`));
    const relevantCount = evidence.payments.reduce((count, payment) => count + payment.operations.filter((operation) => operation.type === 'CAPTURE' || operation.type === 'REFUND').length, 0);
    return { matched: Math.max(0, relevantCount - observedKeys.size), discrepancies, settlementCandidates: candidates };
  }

  /** Compatibility adapter for the Iteration 1 learning demo. New code uses reconcileEvidence. */
  reconcile(
    payments: Array<{ id: string; status: string; capturedAmountMinor: number; externalPaymentId: string | null }>,
    pspRecords: Array<{ paymentId: string; externalPaymentId: string; operation: string; amountMinor: number; status: string }>,
    ledgerJournals: Array<{ referenceId: string; amountMinor: number }>,
  ): ReconciliationDiscrepancy[] {
    return this.reconcileEvidence({
      payments: payments.map((payment) => ({ ...payment, walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), refundedAmountMinor: 0, currency: 'USD', updatedAt: new Date(0).toISOString(), operations: [{ id: payment.externalPaymentId ?? crypto.randomUUID(), type: 'CAPTURE', status: payment.status === 'CAPTURED' ? 'SUCCEEDED' : 'PENDING', amountMinor: payment.capturedAmountMinor, currency: 'USD', externalPaymentId: payment.externalPaymentId }] })),
      pspRecords: pspRecords.map((record) => ({ ...record, operationId: record.externalPaymentId, operation: record.operation as 'CAPTURE', currency: 'USD', status: record.status as 'SUCCEEDED', createdAt: new Date(0).toISOString() })),
      ledgerJournals: ledgerJournals.map((journal) => ({ referenceType: 'PAYMENT', referenceId: journal.referenceId, debitTotalMinor: journal.amountMinor, creditTotalMinor: journal.amountMinor, currency: 'USD' })),
      now: new Date(), gracePeriodMs: 0,
    }).discrepancies;
  }
}
