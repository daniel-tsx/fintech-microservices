import { InMemoryPaymentRepository } from '../apps/payment-service/src/in-memory-payment.repository.js';
import { PaymentApplication } from '../apps/payment-service/src/payment.application.js';
import { PspSimulator, signWebhook, WebhookVerifier } from '../apps/psp-simulator/src/psp-simulator.js';
import { ReconciliationService } from '../apps/reconciliation-service/src/reconciliation.service.js';
import { SettlementStatementSimulator } from '../apps/psp-simulator/src/settlement-statement.js';
import { settlementEntries } from '../apps/ledger-service/src/postgres-ledger.repository.js';
import { Ledger } from '../apps/ledger-service/src/ledger.domain.js';
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

function settlementFixture(statementScenario: 'MATCHED' | 'MISSING_TRANSACTION' | 'DUPLICATE_TRANSACTION' | 'AMOUNT_MISMATCH' = 'MATCHED') {
  const paymentId = crypto.randomUUID(); const operationId = crypto.randomUUID(); const externalPaymentId = crypto.randomUUID();
  const payment = { id: paymentId, walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), status: 'CAPTURED' as const, capturedAmountMinor: 10_000, refundedAmountMinor: 0, currency: 'USD', updatedAt: '2026-01-01T01:00:00.000Z', operations: [{ id: operationId, type: 'CAPTURE' as const, status: 'SUCCEEDED' as const, amountMinor: 10_000, currency: 'USD', externalPaymentId }] };
  const psp = { paymentId, operationId, externalPaymentId, operation: 'CAPTURE' as const, amountMinor: 10_000, currency: 'USD', status: 'SUCCEEDED' as const, createdAt: '2026-01-01T01:00:00.000Z' };
  const statement = new SettlementStatementSimulator('demo-secret', () => new Date('2026-01-02T00:00:00.000Z')).generate({ providerSettlementId: 'demo-batch', windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-02T00:00:00.000Z', currency: 'USD', records: [{ ...psp, providerSequence: 1 }], scenario: statementScenario });
  const ledger = { referenceType: 'PAYMENT' as const, referenceId: paymentId, debitTotalMinor: 10_000, creditTotalMinor: 10_000, currency: 'USD' };
  return { payment, psp, statement, ledger };
}

function settlementDemo(mode: 'happy' | 'ledger-missing' | 'provider-missing' | 'amount-mismatch' | 'duplicate' | 'manual-review') {
  const input = settlementFixture(mode === 'duplicate' ? 'DUPLICATE_TRANSACTION' : 'MATCHED');
  if (mode === 'amount-mismatch' || mode === 'manual-review') input.psp.amountMinor = 9_000;
  const result = new ReconciliationService().reconcileEvidence({ payments: [input.payment], pspRecords: mode === 'provider-missing' ? [] : [input.psp], ledgerJournals: mode === 'ledger-missing' ? [] : [input.ledger], statement: input.statement, gracePeriodMs: 0, now: new Date('2026-01-03T00:00:00.000Z') });
  log('payment', input.payment); log('psp', mode === 'provider-missing' ? [] : [input.psp]); log('settlement-statement', input.statement); log('reconciliation', result);
  if (mode === 'happy' && result.settlementCandidates[0] !== undefined) {
    const candidate = result.settlementCandidates[0]; const ledger = new Ledger(); const settlementItemId = crypto.randomUUID();
    if (candidate.operation.type === 'AUTHORIZE') throw new Error('authorization cannot be settled');
    const entries = settlementEntries({ settlementBatchId: crypto.randomUUID(), settlementItemId, providerSettlementId: input.statement.providerSettlementId, providerTransactionId: candidate.item.providerTransactionId, paymentId: candidate.payment.id, operationId: candidate.operation.id, operationType: candidate.operation.type, grossAmountMinor: candidate.item.grossAmountMinor, feeAmountMinor: candidate.item.feeAmountMinor, netAmountMinor: candidate.item.netAmountMinor, currency: candidate.item.currency }, { processorAccountId: crypto.randomUUID(), cashAccountId: crypto.randomUUID(), feeAccountId: crypto.randomUUID() });
    log('ledger-settlement-journal', ledger.post({ referenceType: 'SETTLEMENT', referenceId: settlementItemId, correlationId: crypto.randomUUID(), entries }));
  }
  if (mode === 'manual-review') log('repair-decision', 'AMOUNT_MISMATCH is REQUIRES_REVIEW; no Payment, PSP, or Ledger mutation is performed.');
}

async function autoRepairUnknownPayment() {
  const { application, psp } = paymentFixture();
  const input = { walletId: crypto.randomUUID(), merchantId: crypto.randomUUID(), customerId: crypto.randomUUID(), amountMinor: 10_000, currency: 'USD' };
  const created = await application.create(input, `reconcile-${crypto.randomUUID()}`, crypto.randomUUID());
  await application.authorize(created.id, input.customerId, crypto.randomUUID());
  const unknown = await application.capture(created.id, `capture-${created.id}`, crypto.randomUUID(), 'TIMEOUT_AFTER_PROCESSING');
  const providerCapture = psp.allRecords().find((record) => record.operation === 'CAPTURE')!;
  log('payment-before-repair', unknown); log('authoritative-provider-operation', providerCapture);
  log('payment-after-verified-reconciliation-repair', await application.reconcileSucceededOperation({ operationId: providerCapture.operationId, amountMinor: providerCapture.amountMinor, currency: providerCapture.currency, externalPaymentId: providerCapture.externalPaymentId, providerSequence: providerCapture.providerSequence }, crypto.randomUUID()));
}

switch (scenario) {
  case 'happy-payment': await happyPayment(); break;
  case 'payment-timeout': await paymentTimeout(); break;
  case 'duplicate-webhook': await duplicateWebhook(); break;
  case 'webhook-ordering': await webhookOrdering(); break;
  case 'transfer-concurrency': await transferConcurrency(); break;
  case 'reconciliation-mismatch': reconciliationMismatch(); break;
  case 'settlement-happy-path': settlementDemo('happy'); break;
  case 'reconciliation-ledger-missing': settlementDemo('ledger-missing'); break;
  case 'reconciliation-provider-missing': settlementDemo('provider-missing'); break;
  case 'reconciliation-amount-mismatch': settlementDemo('amount-mismatch'); break;
  case 'duplicate-settlement': settlementDemo('duplicate'); break;
  case 'auto-repair-unknown-payment': await autoRepairUnknownPayment(); break;
  case 'manual-review-mismatch': settlementDemo('manual-review'); break;
  case 'refund': await happyPayment(true); break;
  default: throw new Error(`Unknown demo '${scenario ?? ''}'`);
}
