import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@ledgerflow/platform';
import type { PspRecord } from './psp-simulator.js';

export const statementScenarios = ['MATCHED', 'MISSING_TRANSACTION', 'DUPLICATE_TRANSACTION', 'AMOUNT_MISMATCH', 'FEE_MISMATCH', 'NET_MISMATCH', 'WRONG_STATUS', 'UNKNOWN_TRANSACTION', 'WRONG_BATCH', 'MALFORMED_ITEM'] as const;
export type StatementScenario = (typeof statementScenarios)[number];

export interface ProviderSettlementItem {
  providerItemId: string;
  providerTransactionId: string;
  merchantReference: string;
  operationId: string;
  operationType: 'CAPTURE' | 'REFUND';
  grossAmountMinor: number;
  feeAmountMinor: number;
  netAmountMinor: number;
  currency: string;
  providerStatus: 'SETTLED' | 'REJECTED';
  settlementBatchId: string;
  settledAt: string;
}

export interface ProviderSettlementStatement {
  provider: 'LEDGERFLOW_PSP';
  providerSettlementId: string;
  windowStart: string;
  windowEnd: string;
  currency: string;
  itemCount: number;
  grossTotalMinor: number;
  feeTotalMinor: number;
  netTotalMinor: number;
  generatedAt: string;
  items: ProviderSettlementItem[];
  signature: string;
}

export function providerFee(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError('amountMinor must be a positive safe integer');
  return Math.floor((amountMinor * 300) / 10_000);
}

function unsigned(statement: ProviderSettlementStatement): Omit<ProviderSettlementStatement, 'signature'> {
  const { signature, ...value } = statement;
  void signature;
  return value;
}

export function signSettlementStatement(secret: string, statement: Omit<ProviderSettlementStatement, 'signature'>): string {
  return createHmac('sha256', secret).update(canonicalJson(statement)).digest('hex');
}

export function verifySettlementStatement(secret: string, statement: ProviderSettlementStatement): boolean {
  const expected = Buffer.from(signSettlementStatement(secret, unsigned(statement)), 'hex');
  const actual = Buffer.from(statement.signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function totals(items: ProviderSettlementItem[]) {
  return items.reduce((result, item) => ({
    grossTotalMinor: result.grossTotalMinor + (item.operationType === 'REFUND' ? -item.grossAmountMinor : item.grossAmountMinor),
    feeTotalMinor: result.feeTotalMinor + item.feeAmountMinor,
    netTotalMinor: result.netTotalMinor + item.netAmountMinor,
  }), { grossTotalMinor: 0, feeTotalMinor: 0, netTotalMinor: 0 });
}

export function validateStatementIntegrity(statement: ProviderSettlementStatement): string[] {
  const problems: string[] = [];
  const calculated = totals(statement.items);
  if (statement.itemCount !== statement.items.length) problems.push('ITEM_COUNT_MISMATCH');
  if (statement.grossTotalMinor !== calculated.grossTotalMinor) problems.push('GROSS_TOTAL_MISMATCH');
  if (statement.feeTotalMinor !== calculated.feeTotalMinor) problems.push('FEE_TOTAL_MISMATCH');
  if (statement.netTotalMinor !== calculated.netTotalMinor) problems.push('NET_TOTAL_MISMATCH');
  if (statement.items.some((item) => item.currency !== statement.currency)) problems.push('MIXED_CURRENCY');
  if (statement.items.some((item) => item.settlementBatchId !== statement.providerSettlementId)) problems.push('WRONG_BATCH');
  return problems;
}

export class SettlementStatementSimulator {
  constructor(private readonly secret: string, private readonly now = () => new Date()) {}

  generate(input: {
    providerSettlementId: string;
    windowStart: string;
    windowEnd: string;
    currency: string;
    records: readonly PspRecord[];
    scenario?: StatementScenario;
  }): ProviderSettlementStatement {
    const start = Date.parse(input.windowStart);
    const end = Date.parse(input.windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new RangeError('invalid settlement window');
    let items = input.records
      .filter((record) => record.status === 'SUCCEEDED'
        && (record.operation === 'CAPTURE' || record.operation === 'REFUND')
        && record.currency === input.currency
        && Date.parse(record.createdAt) >= start
        && Date.parse(record.createdAt) < end)
      .sort((left, right) => left.providerSequence - right.providerSequence)
      .map((record): ProviderSettlementItem => {
        const feeAmountMinor = record.operation === 'CAPTURE' ? providerFee(record.amountMinor) : 0;
        return {
          providerItemId: `${input.providerSettlementId}:${record.operationId}`,
          providerTransactionId: record.operationId,
          merchantReference: record.paymentId,
          operationId: record.operationId,
          operationType: record.operation as 'CAPTURE' | 'REFUND',
          grossAmountMinor: record.amountMinor,
          feeAmountMinor,
          netAmountMinor: record.operation === 'REFUND' ? -record.amountMinor : record.amountMinor - feeAmountMinor,
          currency: record.currency,
          providerStatus: 'SETTLED',
          settlementBatchId: input.providerSettlementId,
          settledAt: input.windowEnd,
        };
      });
    items = this.applyScenario(items, input.scenario ?? 'MATCHED', input);
    const generatedAt = this.now().toISOString();
    const statementWithoutSignature = {
      provider: 'LEDGERFLOW_PSP' as const,
      providerSettlementId: input.providerSettlementId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      currency: input.currency,
      itemCount: items.length,
      ...totals(items),
      generatedAt,
      items,
    };
    return { ...statementWithoutSignature, signature: signSettlementStatement(this.secret, statementWithoutSignature) };
  }

  private applyScenario(items: ProviderSettlementItem[], scenario: StatementScenario, input: { providerSettlementId: string; currency: string; windowEnd: string }): ProviderSettlementItem[] {
    const result = items.map((item) => ({ ...item }));
    const first = result[0];
    if (scenario === 'MISSING_TRANSACTION') return result.slice(1);
    if (scenario === 'DUPLICATE_TRANSACTION' && first !== undefined) result.push({ ...first, providerItemId: `${first.providerItemId}:duplicate` });
    if (scenario === 'AMOUNT_MISMATCH' && first !== undefined) { first.grossAmountMinor -= 1; first.netAmountMinor -= 1; }
    if (scenario === 'FEE_MISMATCH' && first !== undefined) { first.feeAmountMinor += 1; first.netAmountMinor -= 1; }
    if (scenario === 'NET_MISMATCH' && first !== undefined) first.netAmountMinor -= 1;
    if (scenario === 'WRONG_STATUS' && first !== undefined) first.providerStatus = 'REJECTED';
    if (scenario === 'WRONG_BATCH' && first !== undefined) first.settlementBatchId = `${input.providerSettlementId}-other`;
    if (scenario === 'UNKNOWN_TRANSACTION') result.push({
      providerItemId: `${input.providerSettlementId}:unknown`, providerTransactionId: crypto.randomUUID(), merchantReference: crypto.randomUUID(), operationId: crypto.randomUUID(), operationType: 'CAPTURE', grossAmountMinor: 1_000, feeAmountMinor: 30, netAmountMinor: 970, currency: input.currency, providerStatus: 'SETTLED', settlementBatchId: input.providerSettlementId, settledAt: input.windowEnd,
    });
    if (scenario === 'MALFORMED_ITEM' && first !== undefined) first.currency = 'INVALID';
    return result;
  }
}
