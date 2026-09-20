import { z } from 'zod';
import type { PspPort, PspResult, RiskDecision, RiskPort } from './payment.domain.js';

const riskResponse = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reasonCodes: z.array(z.string()) });
const pspResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('APPROVED'), externalPaymentId: z.string() }),
  z.object({ outcome: z.literal('DECLINED'), code: z.string() }),
  z.object({ outcome: z.literal('UNKNOWN'), requestId: z.string() }),
]);

async function postJson(url: string, body: unknown, timeoutMs = 2_000): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`dependency returned HTTP ${response.status}`);
  return response.json();
}

export class HttpRiskAdapter implements RiskPort {
  constructor(private readonly baseUrl: string) {}
  async evaluate(input: { customerId: string; amountMinor: number; currency: string }): Promise<RiskDecision> {
    return riskResponse.parse(await postJson(`${this.baseUrl}/v1/risk/evaluations`, input));
  }
}

export class HttpPspAdapter implements PspPort {
  constructor(private readonly baseUrl: string) {}
  async authorize(input: { paymentId: string; amountMinor: number; currency: string }): Promise<PspResult> {
    try { return pspResponse.parse(await postJson(`${this.baseUrl}/v1/authorizations`, input)); }
    catch (error) { if (error instanceof DOMException && error.name === 'TimeoutError') return { outcome: 'UNKNOWN', requestId: crypto.randomUUID() }; throw error; }
  }
  async capture(input: { paymentId: string; externalPaymentId: string; amountMinor: number }): Promise<PspResult> {
    try { return pspResponse.parse(await postJson(`${this.baseUrl}/v1/captures`, input)); }
    catch (error) { if (error instanceof DOMException && error.name === 'TimeoutError') return { outcome: 'UNKNOWN', requestId: crypto.randomUUID() }; throw error; }
  }
  async refund(input: { paymentId: string; externalPaymentId: string; amountMinor: number }): Promise<PspResult> {
    try { return pspResponse.parse(await postJson(`${this.baseUrl}/v1/refunds`, input)); }
    catch (error) { if (error instanceof DOMException && error.name === 'TimeoutError') return { outcome: 'UNKNOWN', requestId: crypto.randomUUID() }; throw error; }
  }
}
