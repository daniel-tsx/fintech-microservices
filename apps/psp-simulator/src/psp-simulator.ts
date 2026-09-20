import type { PspScenario } from '@ledgerflow/contracts';
import type { PaymentOperationType, PspOperationInput, PspPort, PspResult, PspStatus, WebhookEnvelope } from '../../payment-service/src/payment.domain.js';
export { signWebhook } from '../../payment-service/src/webhook-security.js';
import { verifyWebhookSignature } from '../../payment-service/src/webhook-security.js';

export interface PspRecord { externalPaymentId: string; operationId: string; paymentId: string; operation: PaymentOperationType; amountMinor: number; currency: string; status: 'SUCCEEDED' | 'DECLINED'; providerSequence: number; createdAt: string }

export class PspSimulator implements PspPort {
  private readonly scenarios: PspScenario[] = [];
  private readonly records = new Map<string, PspRecord>();
  private sequence = 0;
  readonly emittedWebhooks: WebhookEnvelope[] = [];

  enqueue(...scenarios: PspScenario[]): void { this.scenarios.push(...scenarios); }
  authorize(input: PspOperationInput): Promise<PspResult> { return this.execute('AUTHORIZE', input); }
  capture(input: PspOperationInput): Promise<PspResult> { return this.execute('CAPTURE', input); }
  refund(input: PspOperationInput): Promise<PspResult> { return this.execute('REFUND', input); }
  async query(operationId: string): Promise<PspStatus> { const record = this.records.get(operationId); return record === undefined ? { outcome: 'NOT_FOUND' } : this.result(record); }
  allRecords(): PspRecord[] { return Array.from(this.records.values(), (record) => structuredClone(record)); }

  private async execute(operation: PaymentOperationType, input: PspOperationInput): Promise<PspResult> {
    const prior = this.records.get(input.operationId); if (prior !== undefined) return this.result(prior);
    const scenario = input.scenario ?? this.scenarios.shift() ?? 'SUCCESS';
    if (scenario === 'HTTP_500') return { outcome: 'FAILED', code: 'PSP_HTTP_500' };
    if (scenario === 'TIMEOUT_BEFORE_PROCESSING') return { outcome: 'UNKNOWN', code: 'PSP_TIMEOUT' };
    if (scenario === 'SLOW_SUCCESS' || scenario === 'SLOW_DECLINE') await new Promise((resolve) => setTimeout(resolve, 10));
    const record: PspRecord = { externalPaymentId: input.externalPaymentId ?? crypto.randomUUID(), operationId: input.operationId, paymentId: input.paymentId, operation, amountMinor: input.amountMinor, currency: input.currency, status: scenario === 'DECLINE' || scenario === 'SLOW_DECLINE' ? 'DECLINED' : 'SUCCEEDED', providerSequence: ++this.sequence, createdAt: new Date().toISOString() };
    this.records.set(input.operationId, record);
    const webhook = this.webhook(record);
    if (['WEBHOOK_BEFORE_HTTP_RESPONSE', 'WEBHOOK_AFTER_HTTP_RESPONSE', 'DELAYED_WEBHOOK', 'OUT_OF_ORDER_WEBHOOK', 'TIMEOUT_AFTER_PROCESSING', 'HTTP_RESPONSE_LOST_AFTER_SUCCESS'].includes(scenario)) this.emittedWebhooks.push(webhook);
    if (scenario === 'DUPLICATE_WEBHOOK') this.emittedWebhooks.push(webhook, structuredClone(webhook));
    if (scenario === 'TIMEOUT_AFTER_PROCESSING' || scenario === 'HTTP_RESPONSE_LOST_AFTER_SUCCESS') return { outcome: 'UNKNOWN', code: 'PSP_TIMEOUT' };
    return this.result(record);
  }
  private result(record: PspRecord): PspResult { return record.status === 'SUCCEEDED' ? { outcome: 'SUCCEEDED', externalPaymentId: record.externalPaymentId, providerSequence: record.providerSequence } : { outcome: 'DECLINED', code: 'PSP_DECLINED', externalPaymentId: record.externalPaymentId, providerSequence: record.providerSequence }; }
  private webhook(record: PspRecord): WebhookEnvelope { return { eventId: crypto.randomUUID(), eventType: record.status === 'DECLINED' ? 'DECLINED' : record.operation === 'AUTHORIZE' ? 'AUTHORIZED' : record.operation === 'CAPTURE' ? 'CAPTURED' : 'REFUNDED', operationId: record.operationId, operationType: record.operation, paymentId: record.paymentId, externalPaymentId: record.externalPaymentId, amountMinor: record.amountMinor, currency: record.currency, providerSequence: record.providerSequence, occurredAt: record.createdAt }; }
}

export class WebhookVerifier {
  constructor(private readonly secret: string, private readonly toleranceSeconds = 300, private readonly now = () => Date.now()) {}
  verify(input: { timestamp: number; rawBody: string; signature: string }): boolean { return verifyWebhookSignature({ secret: this.secret, timestamp: input.timestamp, rawBody: input.rawBody, signature: input.signature, toleranceSeconds: this.toleranceSeconds, now: this.now() }); }
}
