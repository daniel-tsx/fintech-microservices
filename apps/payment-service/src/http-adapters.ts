import { z } from 'zod';
import type { PspOperationInput, PspPort, PspResult, PspStatus, RiskDecision, RiskPort } from './payment.domain.js';

const riskResponse = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reasonCodes: z.array(z.string()) });
const definitivePspResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('SUCCEEDED'), externalPaymentId: z.string().uuid(), providerSequence: z.number().int().positive() }),
  z.object({ outcome: z.literal('DECLINED'), externalPaymentId: z.string().uuid(), providerSequence: z.number().int().positive(), code: z.string().min(1) }),
]);

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 2_000): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
}

export class HttpRiskAdapter implements RiskPort {
  constructor(private readonly baseUrl: string) {}
  async evaluate(input: { paymentId: string; customerId: string; amountMinor: number; currency: string }): Promise<RiskDecision> {
    const response = await postJson(`${this.baseUrl}/v1/risk/evaluations`, input);
    if (!response.ok) throw new Error(`risk dependency returned HTTP ${response.status}`);
    return riskResponse.parse(await response.json());
  }
}

export class HttpPspAdapter implements PspPort {
  constructor(private readonly baseUrl: string) {}

  authorize(input: PspOperationInput): Promise<PspResult> { return this.mutate('/v1/authorizations', input); }
  capture(input: PspOperationInput): Promise<PspResult> { return this.mutate('/v1/captures', input); }
  refund(input: PspOperationInput): Promise<PspResult> { return this.mutate('/v1/refunds', input); }

  async query(operationId: string): Promise<PspStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/provider-transactions/${operationId}`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 404) return { outcome: 'NOT_FOUND' };
      if (!response.ok) return { outcome: 'FAILED', code: `PSP_HTTP_${response.status}` };
      return definitivePspResponse.parse(await response.json());
    } catch {
      return { outcome: 'UNKNOWN', code: 'PSP_STATUS_UNAVAILABLE' };
    }
  }

  private async mutate(path: string, input: PspOperationInput): Promise<PspResult> {
    try {
      const response = await postJson(`${this.baseUrl}${path}`, input, { 'Idempotency-Key': input.operationId });
      if (response.status >= 500) return { outcome: 'FAILED', code: `PSP_HTTP_${response.status}` };
      if (!response.ok) return { outcome: 'FAILED', code: `PSP_HTTP_${response.status}` };
      return definitivePspResponse.parse(await response.json());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') return { outcome: 'UNKNOWN', code: 'PSP_TIMEOUT' };
      return { outcome: 'UNKNOWN', code: 'PSP_NETWORK_ERROR' };
    }
  }
}
