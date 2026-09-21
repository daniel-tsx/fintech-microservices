import { z } from 'zod';
import type { ProviderSettlementStatement } from '../../psp-simulator/src/settlement-statement.js';
import type { LedgerView, PaymentView, PspView } from './reconciliation.service.js';

const operationSchema = z.object({ id: z.string().uuid(), type: z.enum(['AUTHORIZE','CAPTURE','REFUND']), status: z.enum(['PENDING','SUCCEEDED','DECLINED','FAILED','UNKNOWN']), amountMinor: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/), externalPaymentId: z.string().uuid().nullable() });
const paymentSchema = z.object({ id: z.string().uuid(), walletId: z.string().uuid(), merchantId: z.string().uuid(), status: z.string(), capturedAmountMinor: z.number().int().nonnegative(), refundedAmountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/), updatedAt: z.string().datetime(), operations: z.array(operationSchema) });
const pspSchema = z.object({ paymentId: z.string().uuid(), operationId: z.string().uuid(), externalPaymentId: z.string().uuid(), operation: z.enum(['AUTHORIZE','CAPTURE','REFUND']), amountMinor: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/), status: z.enum(['SUCCEEDED','DECLINED']), createdAt: z.string().datetime() });
const ledgerSchema = z.object({ id: z.string().uuid(), referenceType: z.enum(['PAYMENT','REFUND','SETTLEMENT']), referenceId: z.string().uuid(), debitTotalMinor: z.number().int().positive(), creditTotalMinor: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/) });
const statementItemSchema = z.object({ providerItemId: z.string().min(1), providerTransactionId: z.string().min(1), merchantReference: z.string().uuid(), operationId: z.string().uuid(), operationType: z.enum(['CAPTURE','REFUND']), grossAmountMinor: z.number().int().positive(), feeAmountMinor: z.number().int().nonnegative(), netAmountMinor: z.number().int(), currency: z.string(), providerStatus: z.enum(['SETTLED','REJECTED']), settlementBatchId: z.string().min(1), settledAt: z.string().datetime() });
export const statementSchema = z.object({ provider: z.literal('LEDGERFLOW_PSP'), providerSettlementId: z.string().min(1).max(128), windowStart: z.string().datetime(), windowEnd: z.string().datetime(), currency: z.string().regex(/^[A-Z]{3}$/), itemCount: z.number().int().nonnegative(), grossTotalMinor: z.number().int(), feeTotalMinor: z.number().int().nonnegative(), netTotalMinor: z.number().int(), generatedAt: z.string().datetime(), items: z.array(statementItemSchema).max(10_000), signature: z.string().regex(/^[a-f0-9]{64}$/) });

const pageSchema = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), nextCursor: z.string().nullable() });

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`source request ${url} failed with ${response.status}`);
  return response.json();
}

async function pages<T>(baseUrl: string, path: string, schema: z.ZodType<T>, windowStart: string, windowEnd: string): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ windowStart, windowEnd, limit: '100' });
    if (cursor !== null) query.set('after', cursor);
    const page = pageSchema(schema).parse(await json(`${baseUrl}${path}?${query.toString()}`));
    result.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return result;
}

export class HttpReconciliationSources {
  constructor(private readonly paymentUrl: string, private readonly pspUrl: string, private readonly ledgerUrl: string) {}
  getStatement(providerSettlementId: string): Promise<ProviderSettlementStatement> {
    return json(`${this.pspUrl}/v1/settlement-statements/${encodeURIComponent(providerSettlementId)}`).then((value) => statementSchema.parse(value));
  }
  payments(windowStart: string, windowEnd: string): Promise<PaymentView[]> { return pages(this.paymentUrl, '/v1/reconciliation/payments', paymentSchema, windowStart, windowEnd); }
  pspRecords(windowStart: string, windowEnd: string): Promise<PspView[]> { return pages(this.pspUrl, '/v1/reconciliation/operations', pspSchema, windowStart, windowEnd); }
  ledgerJournals(windowStart: string, windowEnd: string): Promise<Array<LedgerView & { id: string }>> { return pages(this.ledgerUrl, '/v1/reconciliation/journals', ledgerSchema, windowStart, windowEnd); }
}
