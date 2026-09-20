import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PspPort, PspResult } from '../../payment-service/src/payment.domain.js';

export type PspScenario = 'SUCCESS' | 'DECLINE' | 'TIMEOUT_BEFORE_EFFECT' | 'SUCCESS_THEN_TIMEOUT' | 'SLOW_SUCCESS';
type Operation = 'AUTHORIZE' | 'CAPTURE' | 'REFUND';

export interface PspRecord {
  externalPaymentId: string;
  paymentId: string;
  operation: Operation;
  amountMinor: number;
  status: 'SUCCEEDED' | 'DECLINED';
  createdAt: string;
}

export class PspSimulator implements PspPort {
  private readonly scenarios: PspScenario[] = [];
  private readonly recordsByIntent = new Map<string, PspRecord>();

  enqueue(...scenarios: PspScenario[]): void { this.scenarios.push(...scenarios); }

  authorize(input: { paymentId: string; amountMinor: number; currency: string }): Promise<PspResult> {
    return this.execute('AUTHORIZE', input.paymentId, input.amountMinor);
  }

  capture(input: { paymentId: string; externalPaymentId: string; amountMinor: number }): Promise<PspResult> {
    return this.execute('CAPTURE', input.paymentId, input.amountMinor);
  }

  refund(input: { paymentId: string; externalPaymentId: string; amountMinor: number }): Promise<PspResult> {
    return this.execute('REFUND', input.paymentId, input.amountMinor);
  }

  allRecords(): PspRecord[] { return Array.from(this.recordsByIntent.values(), (record) => structuredClone(record)); }

  private async execute(operation: Operation, paymentId: string, amountMinor: number): Promise<PspResult> {
    const intent = `${operation}:${paymentId}:${amountMinor}`;
    const prior = this.recordsByIntent.get(intent);
    if (prior !== undefined) return prior.status === 'SUCCEEDED'
      ? { outcome: 'APPROVED', externalPaymentId: prior.externalPaymentId }
      : { outcome: 'DECLINED', code: 'SIMULATED_DECLINE' };
    const scenario = this.scenarios.shift() ?? 'SUCCESS';
    const externalPaymentId = crypto.randomUUID();
    if (scenario === 'TIMEOUT_BEFORE_EFFECT') return { outcome: 'UNKNOWN', requestId: crypto.randomUUID() };
    if (scenario === 'SLOW_SUCCESS') await new Promise((resolve) => setTimeout(resolve, 50));
    const record: PspRecord = {
      externalPaymentId,
      paymentId,
      operation,
      amountMinor,
      status: scenario === 'DECLINE' ? 'DECLINED' : 'SUCCEEDED',
      createdAt: new Date().toISOString(),
    };
    this.recordsByIntent.set(intent, record);
    if (scenario === 'SUCCESS_THEN_TIMEOUT') return { outcome: 'UNKNOWN', requestId: crypto.randomUUID() };
    return record.status === 'SUCCEEDED'
      ? { outcome: 'APPROVED', externalPaymentId }
      : { outcome: 'DECLINED', code: 'SIMULATED_DECLINE' };
  }
}

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export class WebhookVerifier {
  private readonly seen = new Set<string>();
  constructor(private readonly secret: string, private readonly toleranceSeconds = 300, private readonly now = () => Date.now()) {}

  verify(input: { eventId: string; timestamp: number; rawBody: string; signature: string }): boolean {
    if (this.seen.has(input.eventId)) return false;
    if (Math.abs(Math.floor(this.now() / 1000) - input.timestamp) > this.toleranceSeconds) return false;
    const expected = Buffer.from(signWebhook(this.secret, input.timestamp, input.rawBody), 'hex');
    const actual = Buffer.from(input.signature, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    this.seen.add(input.eventId);
    return true;
  }
}
