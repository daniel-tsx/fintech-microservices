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
  const captured = await application.capture(payment.id, `capture-${payment.id}`, crypto.randomUUID()); log('payment.captured', captured);
  if (refund) log('payment.refunded', await application.refund(payment.id, captured.amountMinor, `refund-${payment.id}`, crypto.randomUUID()));
  log('transactional-outbox', repository.outbox);
}

async function paymentTimeout() {
  const { application, psp, repository } = paymentFixture();
  psp.enqueue('TIMEOUT_AFTER_PROCESSING');
  const input = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 5000, currency: 'USD' };
  const payment = await application.create(input, `demo-${crypto.randomUUID()}`, crypto.randomUUID());
  log('synchronous-result-unknown', await application.authorize(payment.id, input.customerId, crypto.randomUUID()));
  log('psp-actually-succeeded', psp.allRecords());
  const operation = [...repository.operations.values()][0];
  if (operation !== undefined) log('recovered-by-status-query', await application.recoverOperation(operation, crypto.randomUUID()));
  log('lesson', 'An unknown outcome is queried using the same stable operation ID before any safe retry.');
}

async function duplicateWebhook() {
  const { application, repository, psp } = paymentFixture();
  const paymentInput = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 1000, currency: 'USD' };
  const payment = await application.create(paymentInput, `webhook-demo-${crypto.randomUUID()}`, crypto.randomUUID());
  psp.enqueue('DUPLICATE_WEBHOOK');
  await application.authorize(payment.id, paymentInput.customerId, crypto.randomUUID());
  const webhook = psp.emittedWebhooks[0]!;
  const secret = 'demo-process-only-secret';
  const verifier = new WebhookVerifier(secret);
  const body = JSON.stringify(webhook);
  const timestamp = Math.floor(Date.now() / 1000);
  const input = { timestamp, rawBody: body, signature: signWebhook(secret, timestamp, body) };
  log('both-deliveries-authentic', [verifier.verify(input), verifier.verify(input)]);
  log('webhook-ingestion', [await application.ingestPspWebhook(webhook), await application.ingestPspWebhook(webhook)]);
  const [claimed] = await repository.claimWebhookBatch('demo-worker', 10, 30_000);
  if (claimed !== undefined) log('business-processing', await application.processPspWebhook('demo-worker', claimed, crypto.randomUUID()));
  log('one-payment-effect', await repository.findById(payment.id));
  log('lesson', 'HMAC authenticity is stateless; the durable event ID provides business replay protection.');
}

async function webhookOrdering() {
  const { application, repository, psp } = paymentFixture();
  const input = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 2200, currency: 'USD' };
  const payment = await application.create(input, `ordering-demo-${crypto.randomUUID()}`, crypto.randomUUID());
  await application.authorize(payment.id, input.customerId, crypto.randomUUID());
  const authorization = psp.allRecords()[0]!;
  await application.capture(payment.id, `capture-${payment.id}`, crypto.randomUUID());
  const lateAuthorization = { eventId: crypto.randomUUID(), eventType: 'AUTHORIZED' as const, operationId: authorization.operationId, operationType: 'AUTHORIZE' as const, paymentId: payment.id, externalPaymentId: authorization.externalPaymentId, amountMinor: input.amountMinor, currency: input.currency, providerSequence: authorization.providerSequence, occurredAt: new Date().toISOString() };
  await application.ingestPspWebhook(lateAuthorization);
  const [claimed] = await repository.claimWebhookBatch('ordering-demo-worker', 1, 30_000);
  log('late-authorized-callback', await application.processPspWebhook('ordering-demo-worker', claimed!, crypto.randomUUID()));
  log('state-does-not-regress', await repository.findById(payment.id));
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
  case 'duplicate-webhook': await duplicateWebhook(); break;
  case 'webhook-ordering': await webhookOrdering(); break;
  case 'transfer-concurrency': await transferConcurrency(); break;
  case 'reconciliation-mismatch': reconciliationMismatch(); break;
  case 'refund': await happyPayment(true); break;
  default: throw new Error(`Unknown demo '${scenario ?? ''}'`);
}
