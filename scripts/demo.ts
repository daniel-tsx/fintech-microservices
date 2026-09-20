import { InMemoryPaymentRepository } from '../apps/payment-service/src/in-memory-payment.repository.js';
import { PaymentApplication } from '../apps/payment-service/src/payment.application.js';
import { PspSimulator, signWebhook, WebhookVerifier } from '../apps/psp-simulator/src/psp-simulator.js';
import { ReconciliationService } from '../apps/reconciliation-service/src/reconciliation.service.js';
import { DeterministicRiskService } from '../apps/risk-service/src/risk.service.js';
import { WalletBook } from '../apps/wallet-service/src/wallet.domain.js';

const scenario = process.argv[2];
const log = (step: string, data: unknown) => console.log(JSON.stringify({ at: new Date().toISOString(), step, data }, null, 2));

function paymentFixture() {
  const repository = new InMemoryPaymentRepository();
  const psp = new PspSimulator();
  const risk = new DeterministicRiskService({ maximumTransactionMinor: 100_000, maximumDailyAmountMinor: 250_000, maximumDailyCount: 20 });
  return { repository, psp, application: new PaymentApplication(repository, risk, psp) };
}

async function happyPayment(refund = false) {
  const { application, repository } = paymentFixture();
  const input = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 12_500, currency: 'USD' };
  const payment = await application.create(input, `demo-${crypto.randomUUID()}`, crypto.randomUUID()); log('payment.created', payment);
  const authorized = await application.authorize(payment.id, input.customerId, crypto.randomUUID()); log('payment.authorized', authorized);
  const captured = await application.capture(payment.id, crypto.randomUUID()); log('payment.captured', captured);
  if (refund) log('payment.refunded', await application.refund(payment.id, captured.amountMinor, crypto.randomUUID()));
  log('transactional-outbox', repository.outbox);
}

async function paymentTimeout() {
  const { application, psp } = paymentFixture();
  psp.enqueue('SUCCESS_THEN_TIMEOUT');
  const input = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 5000, currency: 'USD' };
  const payment = await application.create(input, `demo-${crypto.randomUUID()}`, crypto.randomUUID());
  log('synchronous-result-unknown', await application.authorize(payment.id, input.customerId, crypto.randomUUID()));
  log('psp-actually-succeeded', psp.allRecords());
  log('lesson', 'Do not retry the authorization blindly. Await webhook or reconciliation.');
}

function duplicateWebhook() {
  const secret = 'demo-process-only-secret';
  const verifier = new WebhookVerifier(secret);
  const body = JSON.stringify({ eventId: crypto.randomUUID(), outcome: 'AUTHORIZED' });
  const timestamp = Math.floor(Date.now() / 1000);
  const input = { eventId: crypto.randomUUID(), timestamp, rawBody: body, signature: signWebhook(secret, timestamp, body) };
  log('first-delivery-accepted', verifier.verify(input));
  log('duplicate-delivery-rejected', verifier.verify(input));
}

async function transferConcurrency() {
  const wallets = new WalletBook(); const walletId = crypto.randomUUID();
  wallets.add({ id: walletId, ownerId: crypto.randomUUID(), currency: 'USD', availableMinor: 1000, pendingMinor: 0, version: 0 });
  log('concurrent-results', await Promise.allSettled([wallets.reserve(walletId, crypto.randomUUID(), 800), wallets.reserve(walletId, crypto.randomUUID(), 800)]));
  log('final-wallet', wallets.get(walletId));
}

function reconciliationMismatch() {
  const paymentId = crypto.randomUUID();
  const result = new ReconciliationService().reconcile(
    [{ id: paymentId, status: 'AUTHORIZATION_PENDING', capturedAmountMinor: 1000, externalPaymentId: null }],
    [{ paymentId, externalPaymentId: 'psp-1', operation: 'CAPTURE', amountMinor: 1000, status: 'SUCCEEDED' }],
    [],
  );
  log('reconciliation-discrepancies', result);
}

switch (scenario) {
  case 'happy-payment': await happyPayment(); break;
  case 'payment-timeout': await paymentTimeout(); break;
  case 'duplicate-webhook': duplicateWebhook(); break;
  case 'transfer-concurrency': await transferConcurrency(); break;
  case 'reconciliation-mismatch': reconciliationMismatch(); break;
  case 'refund': await happyPayment(true); break;
  default: throw new Error(`Unknown demo '${scenario ?? ''}'`);
}
