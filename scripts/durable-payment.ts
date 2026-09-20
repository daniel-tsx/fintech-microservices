import { execFileSync, spawnSync } from 'node:child_process';

const composeEnvironment = { ...process.env, PSP_WEBHOOK_SECRET: process.env.PSP_WEBHOOK_SECRET ?? 'durable-demo-local-only-secret' };

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, { cwd: process.cwd(), encoding: 'utf8', env: composeEnvironment, input });
}

function sql(database: 'payments' | 'ledger', statement: string): string {
  return docker(['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'ledgerflow', '-d', database, '-Atc', statement]).trim();
}

async function waitFor<T>(description: string, operation: () => Promise<T | null>, timeoutMilliseconds = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null) return result;
    } catch { /* dependency is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

try {
  docker(['version']);
} catch {
  throw new Error('Docker is required for demo:durable-payment but is not available on PATH');
}

console.log('Starting PostgreSQL, Redpanda, migrations, Payment dependencies, Payment, and Ledger...');
docker(['compose', 'up', '-d', '--build', 'postgres', 'redpanda', 'migrations', 'risk-service', 'psp-simulator', 'payment-service', 'ledger-service']);

await waitFor('Payment and Ledger readiness', async () => {
  const payment = await fetch('http://127.0.0.1:3002/health/ready');
  const ledger = await fetch('http://127.0.0.1:3005/health/ready');
  return payment.ok && ledger.ok ? true : null;
}, 60_000);

const correlationId = crypto.randomUUID();
const requestId = crypto.randomUUID();
const paymentInput = {
  walletId: crypto.randomUUID(),
  merchantId: crypto.randomUUID(),
  customerId: crypto.randomUUID(),
  amountMinor: 12_500,
  currency: 'USD',
};
const headers = { 'Idempotency-Key': `durable-demo-${crypto.randomUUID()}`, 'x-correlation-id': correlationId, 'x-request-id': requestId };
const created = await postJson<{ id: string; status: string }>('http://127.0.0.1:3002/v1/payments', paymentInput, headers);
await postJson(`http://127.0.0.1:3002/v1/payments/${created.id}/authorize`, { customerId: paymentInput.customerId }, { 'x-correlation-id': correlationId });
await postJson(`http://127.0.0.1:3002/v1/payments/${created.id}/capture`, {}, { 'x-correlation-id': correlationId });

await waitFor('ledger journal', async () => Number(sql('ledger', `SELECT COUNT(*) FROM ledger_journals WHERE reference_id = '${created.id}'`)) === 1 ? true : null);
const paymentBeforeRestart = sql('payments', `SELECT id || '|' || status FROM payments WHERE id = '${created.id}'`);
const outboxBeforeRestart = sql('payments', `SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = '${created.id}' AND published_at IS NOT NULL`);
const ledgerBeforeRestart = sql('ledger', `SELECT COUNT(*) FROM ledger_journals WHERE reference_id = '${created.id}'`);
const entriesBeforeRestart = sql('ledger', `SELECT COUNT(*) FROM ledger_entries WHERE journal_id IN (SELECT id FROM ledger_journals WHERE reference_id = '${created.id}')`);

console.log('Restarting Payment and proving its row survives...');
docker(['compose', 'restart', 'payment-service']);
await waitFor('Payment readiness after restart', async () => (await fetch('http://127.0.0.1:3002/health/ready')).ok ? true : null);
const persistedPayment = await waitFor('persisted payment HTTP read', async () => {
  const response = await fetch(`http://127.0.0.1:3002/v1/payments/${created.id}`);
  return response.ok ? response.json() as Promise<{ id: string; status: string }> : null;
});

console.log('Restarting Ledger and proving its journal survives...');
docker(['compose', 'restart', 'ledger-service']);
await waitFor('Ledger readiness after restart', async () => (await fetch('http://127.0.0.1:3005/health/ready')).ok ? true : null);

const capturedEnvelope = sql('payments', `SELECT payload::text FROM outbox_events WHERE aggregate_id = '${created.id}' AND payload->>'eventType' = 'payment.captured.v1' LIMIT 1`);
const replay = spawnSync('docker', ['compose', 'exec', '-T', 'redpanda', 'rpk', 'topic', 'produce', 'ledgerflow.payments.v1', '--brokers', 'redpanda:9092', '--key', created.id], {
  cwd: process.cwd(), encoding: 'utf8', env: composeEnvironment, input: `${capturedEnvelope}\n`,
});
if (replay.status !== 0) throw new Error(`Kafka replay failed: ${replay.stderr}`);
await new Promise((resolve) => setTimeout(resolve, 2_000));

const ledgerAfterReplay = sql('ledger', `SELECT COUNT(*) FROM ledger_journals WHERE reference_id = '${created.id}'`);
const entriesAfterReplay = sql('ledger', `SELECT COUNT(*) FROM ledger_entries WHERE journal_id IN (SELECT id FROM ledger_journals WHERE reference_id = '${created.id}')`);
const inboxCount = sql('ledger', `SELECT COUNT(*) FROM inbox_events WHERE event_id = (SELECT source_event_id FROM ledger_journals WHERE reference_id = '${created.id}')`);

console.log(JSON.stringify({
  paymentId: created.id,
  correlationId,
  requestId,
  paymentBeforeRestart,
  persistedPayment,
  publishedOutboxEvents: Number(outboxBeforeRestart),
  ledgerBeforeRestart: { journals: Number(ledgerBeforeRestart), entries: Number(entriesBeforeRestart) },
  ledgerAfterDuplicateReplay: { journals: Number(ledgerAfterReplay), entries: Number(entriesAfterReplay), inboxRows: Number(inboxCount) },
  duplicateWasSafe: ledgerBeforeRestart === ledgerAfterReplay && entriesBeforeRestart === entriesAfterReplay,
  note: 'Services remain running so the databases and logs can be inspected.',
}, null, 2));
