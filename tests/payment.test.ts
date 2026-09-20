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
  it('honours idempotency and rejects key reuse with a different payload', async () => {
    const { app, repository } = fixture();
    const request = command();
    const first = await app.create(request, 'checkout-order-1', crypto.randomUUID());
    const replay = await app.create(request, 'checkout-order-1', crypto.randomUUID());
    expect(replay.id).toBe(first.id);
    expect(repository.outbox).toHaveLength(1);
    await expect(app.create({ ...request, amountMinor: 2600 }, 'checkout-order-1', crypto.randomUUID())).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  it('keeps a PSP success-then-timeout pending until a webhook resolves it', async () => {
    const { app, psp } = fixture();
    psp.enqueue('SUCCESS_THEN_TIMEOUT');
    const request = command();
    const created = await app.create(request, 'checkout-order-2', crypto.randomUUID());
    const pending = await app.authorize(created.id, request.customerId, crypto.randomUUID());
    expect(pending.status).toBe('AUTHORIZATION_PENDING');
    const record = psp.allRecords()[0];
    expect(record).toBeDefined();
    const eventId = crypto.randomUUID();
    const resolved = await app.applyPspWebhook({ eventId, paymentId: created.id, outcome: 'AUTHORIZED', externalPaymentId: record!.externalPaymentId, correlationId: crypto.randomUUID() });
    expect(resolved?.status).toBe('AUTHORIZED');
    const replay = await app.applyPspWebhook({ eventId, paymentId: created.id, outcome: 'AUTHORIZED', externalPaymentId: record!.externalPaymentId, correlationId: crypto.randomUUID() });
    expect(replay?.version).toBe(resolved?.version);
  });

  it('runs authorize, capture, partial refund, and full refund', async () => {
    const { app } = fixture();
    const request = command();
    const payment = await app.create(request, 'checkout-order-3', crypto.randomUUID());
    expect((await app.authorize(payment.id, request.customerId, crypto.randomUUID())).status).toBe('AUTHORIZED');
    expect((await app.capture(payment.id, crypto.randomUUID())).status).toBe('CAPTURED');
    expect((await app.refund(payment.id, 1000, crypto.randomUUID())).status).toBe('PARTIALLY_REFUNDED');
    expect((await app.refund(payment.id, 1500, crypto.randomUUID())).status).toBe('REFUNDED');
  });
});
