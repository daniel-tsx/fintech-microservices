import { describe, expect, it } from 'vitest';
import { InMemoryPaymentRepository } from '../apps/payment-service/src/in-memory-payment.repository.js';
import { PaymentApplication } from '../apps/payment-service/src/payment.application.js';
import { IdempotencyMismatchError } from '../apps/payment-service/src/payment.domain.js';
import { DeterministicRiskService } from '../apps/risk-service/src/risk.service.js';
import { PspSimulator } from '../apps/psp-simulator/src/psp-simulator.js';

function fixture() {
  const repository = new InMemoryPaymentRepository();
  const risk = new DeterministicRiskService({ maximumTransactionMinor: 100_000, maximumDailyAmountMinor: 200_000, maximumDailyCount: 10 });
  const psp = new PspSimulator();
  return { repository, psp, app: new PaymentApplication(repository, risk, psp) };
}

const command = () => ({ walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 2500, currency: 'USD' });

describe('payment orchestration', () => {
  it('honours create idempotency and rejects key reuse with a different payload', async () => {
    const { app, repository } = fixture();
    const request = command();
    const first = await app.create(request, 'checkout-order-1', crypto.randomUUID());
    const replay = await app.create(request, 'checkout-order-1', crypto.randomUUID());
    expect(replay.id).toBe(first.id);
    expect(repository.outbox).toHaveLength(1);
    await expect(app.create({ ...request, amountMinor: 2600 }, 'checkout-order-1', crypto.randomUUID())).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  it('records an unknown outcome and resolves it from a durable, deduplicated webhook', async () => {
    const { app, psp, repository } = fixture();
    psp.enqueue('TIMEOUT_AFTER_PROCESSING');
    const request = command();
    const created = await app.create(request, 'checkout-order-2', crypto.randomUUID());
    const unknown = await app.authorize(created.id, request.customerId, crypto.randomUUID());
    expect(unknown.status).toBe('AUTHORIZATION_UNKNOWN');

    const webhook = psp.emittedWebhooks[0];
    expect(webhook).toBeDefined();
    expect(await app.ingestPspWebhook(webhook!)).toBe('ACCEPTED');
    expect(await app.ingestPspWebhook(webhook!)).toBe('DUPLICATE');
    const [claimed] = await repository.claimWebhookBatch('test-worker', 10, 30_000);
    expect(claimed).toEqual(webhook);
    expect(await app.processPspWebhook('test-worker', claimed!, crypto.randomUUID())).toBe('PROCESSED');
    expect((await repository.findById(created.id))?.status).toBe('AUTHORIZED');
    expect(repository.history.map((item) => item.nextStatus)).toEqual([
      'RISK_PENDING', 'RISK_APPROVED', 'AUTHORIZATION_PENDING', 'AUTHORIZATION_UNKNOWN', 'AUTHORIZED',
    ]);
  });

  it('recovers a timeout-before-processing by querying then safely retrying the same PSP operation', async () => {
    const { app, psp, repository } = fixture();
    psp.enqueue('TIMEOUT_BEFORE_PROCESSING');
    const request = command();
    const created = await app.create(request, 'checkout-order-recovery', crypto.randomUUID());
    expect((await app.authorize(created.id, request.customerId, crypto.randomUUID())).status).toBe('AUTHORIZATION_UNKNOWN');
    const operation = [...repository.operations.values()][0]!;
    const recovered = await app.recoverOperation(operation, crypto.randomUUID());
    expect(recovered.status).toBe('AUTHORIZED');
    expect(psp.allRecords()).toHaveLength(1);
    expect(repository.operations.get(operation.id)?.attemptCount).toBe(2);
  });

  it('runs authorize, capture, partial refund, and full refund with stable operation idempotency', async () => {
    const { app, repository, psp } = fixture();
    const request = command();
    const payment = await app.create(request, 'checkout-order-3', crypto.randomUUID());
    expect((await app.authorize(payment.id, request.customerId, crypto.randomUUID())).status).toBe('AUTHORIZED');
    const captured = await app.capture(payment.id, 'capture-order-3', crypto.randomUUID());
    expect(captured.status).toBe('CAPTURED');
    const captureReplay = await app.capture(payment.id, 'capture-order-3', crypto.randomUUID());
    expect(captureReplay.version).toBe(captured.version);
    expect((await app.refund(payment.id, 1000, 'refund-order-3-a', crypto.randomUUID())).status).toBe('PARTIALLY_REFUNDED');
    const refunded = await app.refund(payment.id, 1500, 'refund-order-3-b', crypto.randomUUID());
    expect(refunded.status).toBe('REFUNDED');
    const replay = await app.refund(payment.id, 1500, 'refund-order-3-b', crypto.randomUUID());
    expect(replay.version).toBe(refunded.version);
    expect(repository.operations.size).toBe(4);
    expect(psp.allRecords()).toHaveLength(4);
  });

  it.each([
    ['DECLINE', 'AUTHORIZATION_DECLINED'],
    ['HTTP_500', 'AUTHORIZATION_FAILED'],
    ['TIMEOUT_BEFORE_PROCESSING', 'AUTHORIZATION_UNKNOWN'],
  ] as const)('maps PSP %s to %s without pretending the outcome succeeded', async (scenario, expectedStatus) => {
    const { app, psp } = fixture();
    psp.enqueue(scenario);
    const request = command();
    const payment = await app.create(request, `scenario-${scenario}`, crypto.randomUUID());
    expect((await app.authorize(payment.id, request.customerId, crypto.randomUUID())).status).toBe(expectedStatus);
  });

  it('does not contact the PSP after a risk rejection', async () => {
    const repository = new InMemoryPaymentRepository();
    const psp = new PspSimulator();
    const risk = new DeterministicRiskService({ maximumTransactionMinor: 100, maximumDailyAmountMinor: 100, maximumDailyCount: 1 });
    const app = new PaymentApplication(repository, risk, psp);
    const request = command();
    const payment = await app.create(request, 'risk-rejected', crypto.randomUUID());
    expect((await app.authorize(payment.id, request.customerId, crypto.randomUUID())).status).toBe('RISK_REJECTED');
    expect(psp.allRecords()).toEqual([]);
  });

  it('ignores an old authorization callback after capture and never regresses state', async () => {
    const { app, repository, psp } = fixture();
    const request = command();
    const payment = await app.create(request, 'out-of-order', crypto.randomUUID());
    await app.authorize(payment.id, request.customerId, crypto.randomUUID());
    const authorization = psp.allRecords()[0]!;
    const captured = await app.capture(payment.id, 'out-of-order-capture', crypto.randomUUID());
    const staleWebhook = {
      eventId: crypto.randomUUID(), eventType: 'AUTHORIZED' as const, operationId: authorization.operationId, operationType: 'AUTHORIZE' as const,
      paymentId: payment.id, externalPaymentId: authorization.externalPaymentId, amountMinor: request.amountMinor, currency: request.currency,
      providerSequence: authorization.providerSequence, occurredAt: new Date().toISOString(),
    };
    await app.ingestPspWebhook(staleWebhook);
    const [claimed] = await repository.claimWebhookBatch('ordering-worker', 1, 30_000);
    expect(await app.processPspWebhook('ordering-worker', claimed!, crypto.randomUUID())).toBe('IGNORED');
    expect((await repository.findById(payment.id))?.status).toBe('CAPTURED');
    expect((await repository.findById(payment.id))?.version).toBe(captured.version);
  });

  it('keeps a webhook-confirmed result when the matching HTTP response arrives later', async () => {
    const { app, repository, psp } = fixture();
    psp.enqueue('TIMEOUT_AFTER_PROCESSING');
    const request = command();
    const payment = await app.create(request, 'response-race', crypto.randomUUID());
    await app.authorize(payment.id, request.customerId, crypto.randomUUID());
    const webhook = psp.emittedWebhooks[0]!;
    await app.ingestPspWebhook(webhook);
    const [claimed] = await repository.claimWebhookBatch('race-worker', 1, 30_000);
    await app.processPspWebhook('race-worker', claimed!, crypto.randomUUID());
    const afterWebhook = (await repository.findById(payment.id))!;
    const afterLateResponse = await repository.resolveOperation({
      operationId: webhook.operationId,
      result: { outcome: 'SUCCEEDED', externalPaymentId: webhook.externalPaymentId, providerSequence: webhook.providerSequence },
      source: 'HTTP',
      correlationId: crypto.randomUUID(),
    });
    expect(afterLateResponse).toEqual(afterWebhook);
  });

  it('recovers capture and refund timeouts without duplicate PSP effects and prevents over-refund', async () => {
    const { app, repository, psp } = fixture();
    const request = command();
    const payment = await app.create(request, 'money-operation-recovery', crypto.randomUUID());
    await app.authorize(payment.id, request.customerId, crypto.randomUUID());
    psp.enqueue('TIMEOUT_AFTER_PROCESSING');
    expect((await app.capture(payment.id, 'capture-timeout', crypto.randomUUID())).status).toBe('CAPTURE_UNKNOWN');
    const captureOperation = [...repository.operations.values()].find((operation) => operation.type === 'CAPTURE')!;
    expect((await app.recoverOperation(captureOperation, crypto.randomUUID())).status).toBe('CAPTURED');
    psp.enqueue('TIMEOUT_AFTER_PROCESSING');
    expect((await app.refund(payment.id, 1000, 'refund-timeout', crypto.randomUUID())).status).toBe('REFUND_UNKNOWN');
    const refundOperation = [...repository.operations.values()].find((operation) => operation.type === 'REFUND')!;
    expect((await app.recoverOperation(refundOperation, crypto.randomUUID())).status).toBe('PARTIALLY_REFUNDED');
    expect(psp.allRecords().filter((record) => record.operation === 'CAPTURE')).toHaveLength(1);
    expect(psp.allRecords().filter((record) => record.operation === 'REFUND')).toHaveLength(1);
    await expect(app.refund(payment.id, 1600, 'refund-too-large', crypto.randomUUID())).rejects.toThrow('refund exceeds captured balance');
  });

  it('retries a PSP system failure through pending while reusing the original operation ID', async () => {
    const { app, repository, psp } = fixture();
    psp.enqueue('HTTP_500');
    const request = command();
    const payment = await app.create(request, 'failed-operation-retry', crypto.randomUUID());
    expect((await app.authorize(payment.id, request.customerId, crypto.randomUUID())).status).toBe('AUTHORIZATION_FAILED');
    const originalOperation = [...repository.operations.values()][0]!;
    expect((await app.authorize(payment.id, request.customerId, crypto.randomUUID())).status).toBe('AUTHORIZED');
    expect([...repository.operations.values()]).toHaveLength(1);
    expect([...repository.operations.values()][0]?.id).toBe(originalOperation.id);
    expect(repository.history.map((item) => item.nextStatus)).toContain('AUTHORIZATION_PENDING');
    expect(repository.history.at(-2)?.nextStatus).toBe('AUTHORIZATION_PENDING');
  });
});
