import 'reflect-metadata';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query, ServiceUnavailableException, UnauthorizedException, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { KafkaMessageProducer, bootstrapService, requiredEnvironment, structuredLog } from '@ledgerflow/platform';
import { verifySettlementStatement, validateStatementIntegrity } from '../../psp-simulator/src/settlement-statement.js';
import { createReconciliationDatabase } from './database.js';
import { HttpReconciliationSources, statementSchema } from './http-sources.js';
import { ReconciliationOutboxWorker } from './outbox.worker.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReconciliationOutboxStore, ReconciliationStore, RunLeaseUnavailableError, StatementConflictError, UnsafeRepairError, statementSourceDigest } from './reconciliation.store.js';

class RunRequest { @ApiProperty() @IsString() @Length(1, 128) providerSettlementId!: string; }
class DiscrepancyQuery { @IsOptional() @IsIn(['OPEN','ACKNOWLEDGED','UNDER_REVIEW','RESOLVED','FALSE_POSITIVE','ESCALATED']) status?: string; }
class ReviewRequest {
  @ApiProperty({ enum: ['ACKNOWLEDGE','MARK_FALSE_POSITIVE','ESCALATE','RESOLVE'] }) @IsIn(['ACKNOWLEDGE','MARK_FALSE_POSITIVE','ESCALATE','RESOLVE']) action!: 'ACKNOWLEDGE' | 'MARK_FALSE_POSITIVE' | 'ESCALATE' | 'RESOLVE';
  @ApiProperty() @IsString() @Length(1, 500) note!: string;
  @ApiProperty() @IsString() @Length(1, 100) actor!: string;
}
class RepairRequest { @ApiProperty() @IsString() @Length(1, 100) actor!: string; }

const db = createReconciliationDatabase(requiredEnvironment('DATABASE_URL'));
const store = new ReconciliationStore(db);
const engine = new ReconciliationService();
const sources = new HttpReconciliationSources(process.env.PAYMENT_URL ?? 'http://localhost:3002', process.env.PSP_URL ?? 'http://localhost:3004', process.env.LEDGER_URL ?? 'http://localhost:3005');
const statementSecret = requiredEnvironment('PSP_STATEMENT_SECRET');
const operatorToken = requiredEnvironment('RECONCILIATION_OPERATOR_TOKEN');
const workerId = `reconciliation-${process.pid}-${crypto.randomUUID()}`;
const outboxWorker = new ReconciliationOutboxWorker(new ReconciliationOutboxStore(db, workerId), new KafkaMessageProducer('ledgerflow-reconciliation-outbox', requiredEnvironment('KAFKA_BROKERS').split(',').map((item) => item.trim())));

function authorize(value: string | undefined): void {
  if (value === undefined || value !== operatorToken) throw new UnauthorizedException({ error: { code: 'OPERATOR_AUTH_REQUIRED', message: 'A valid x-operator-token header is required' } });
}
function correlation(value: string | undefined): string { return value !== undefined && /^[0-9a-f-]{36}$/i.test(value) ? value : crypto.randomUUID(); }

@ApiTags('reconciliation')
@Controller()
class ReconciliationController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') async ready() { await db`SELECT 1`; if (!outboxWorker.isReady()) throw new ServiceUnavailableException({ status: 'not-ready', dependency: 'outbox-worker' }); return { status: 'ready', persistence: 'postgresql', messaging: 'redpanda-kafka' }; }

  @Post('v1/reconciliation/runs')
  async run(@Body() body: RunRequest, @Headers('x-operator-token') token?: string, @Headers('x-correlation-id') correlationHeader?: string) {
    authorize(token);
    const correlationId = correlation(correlationHeader);
    const statement = statementSchema.parse(await sources.getStatement(body.providerSettlementId));
    const signatureVerified = verifySettlementStatement(statementSecret, statement);
    const integrityErrors = validateStatementIntegrity(statement);
    if (!signatureVerified) integrityErrors.push('INVALID_SIGNATURE');
    let ingestion: { batchId: string; duplicate: boolean };
    try { ingestion = await store.ingestStatement(statement, signatureVerified, integrityErrors); }
    catch (error) { if (error instanceof StatementConflictError) throw new ConflictException({ error: { code: 'STATEMENT_IDENTITY_CONFLICT', message: error.message } }); throw error; }
    const fatalIntegrityErrors = integrityErrors.filter((problem) => !['MIXED_CURRENCY','WRONG_BATCH'].includes(problem));
    if (fatalIntegrityErrors.length > 0) throw new BadRequestException({ error: { code: 'STATEMENT_INTEGRITY_FAILED', problems: fatalIntegrityErrors, batchId: ingestion.batchId } });
    const sourceDigest = await statementSourceDigest(statement);
    const run = await store.createRun({ provider: statement.provider, batchId: ingestion.batchId, windowStart: statement.windowStart, windowEnd: statement.windowEnd, sourceDigest });
    if (run.duplicate && run.status === 'COMPLETED') return { runId: run.runId, settlementBatchId: ingestion.batchId, duplicateStatement: ingestion.duplicate, duplicateRun: true, status: 'COMPLETED' };
    const runLeaseOwner = `${workerId}:${crypto.randomUUID()}`;
    try {
      await store.acquireRunLease(run.runId, runLeaseOwner);
      const [payments, pspRecords, ledgerJournals] = await Promise.all([
        sources.payments(statement.windowStart, statement.windowEnd),
        sources.pspRecords(statement.windowStart, statement.windowEnd),
        sources.ledgerJournals(statement.windowStart, new Date().toISOString()),
      ]);
      await store.confirmLedgerSettlements(ingestion.batchId, ledgerJournals.filter((journal) => journal.referenceType === 'SETTLEMENT').map((journal) => journal.referenceId));
      const result = engine.reconcileEvidence({ payments, pspRecords, ledgerJournals, statement, gracePeriodMs: Number(process.env.RECONCILIATION_GRACE_MS ?? 30_000) });
      await store.persistResult(run.runId, ingestion.batchId, result, correlationId);
      structuredLog('info', 'reconciliation run completed', { correlationId, runId: run.runId, settlementBatchId: ingestion.batchId, providerSettlementId: statement.providerSettlementId, matched: result.matched, mismatchCount: result.discrepancies.length, settlementCandidates: result.settlementCandidates.length, duplicateStatement: ingestion.duplicate, duplicateRun: run.duplicate });
      return { runId: run.runId, settlementBatchId: ingestion.batchId, duplicateStatement: ingestion.duplicate, duplicateRun: run.duplicate, matched: result.matched, discrepancies: result.discrepancies.length, settlementCandidates: result.settlementCandidates.length };
    } catch (error) {
      await store.markRunFailed(run.runId, runLeaseOwner);
      if (error instanceof RunLeaseUnavailableError) throw new ConflictException({ error: { code: 'RUN_LEASE_UNAVAILABLE', message: error.message } });
      throw error;
    }
  }

  @Get('v1/reconciliation/runs/:id') async getRun(@Param('id', ParseUUIDPipe) id: string, @Headers('x-operator-token') token?: string) { authorize(token); const run = await store.getRun(id); if (run === null) throw new NotFoundException(); return run; }
  @Get('v1/reconciliation/discrepancies') async discrepancies(@Query() query: DiscrepancyQuery, @Headers('x-operator-token') token?: string) { authorize(token); return { data: await store.listDiscrepancies(query.status) }; }
  @Get('v1/reconciliation/discrepancies/:id') async discrepancy(@Param('id', ParseUUIDPipe) id: string, @Headers('x-operator-token') token?: string) { authorize(token); const value = await store.getDiscrepancy(id); if (value === null) throw new NotFoundException(); return value; }
  @Post('v1/reconciliation/discrepancies/:id/resolve') async review(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewRequest, @Headers('x-operator-token') token?: string, @Headers('x-correlation-id') correlationHeader?: string) { authorize(token); const value = await store.review({ discrepancyId: id, ...body, correlationId: correlation(correlationHeader) }); if (value === null) throw new NotFoundException(); return value; }
  @Post('v1/reconciliation/discrepancies/:id/retry-repair') async repair(@Param('id', ParseUUIDPipe) id: string, @Body() body: RepairRequest, @Headers('x-operator-token') token?: string, @Headers('x-correlation-id') correlationHeader?: string) { authorize(token); try { const value = await store.emitSafeLedgerRepair(id, body.actor, correlation(correlationHeader)); if (value === null) throw new NotFoundException(); return value; } catch (error) { if (error instanceof UnsafeRepairError) throw new ConflictException({ error: { code: 'UNSAFE_AUTOMATIC_REPAIR', message: error.message } }); throw error; } }
}

@Injectable()
class ReconciliationLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  async onApplicationBootstrap() { await outboxWorker.start(); }
  async onApplicationShutdown() { await outboxWorker.stop(); await db.end({ timeout: 5 }); }
}
@Module({ controllers: [ReconciliationController], providers: [ReconciliationLifecycle] })
class ReconciliationModule {}

void bootstrapService(ReconciliationModule, 'LedgerFlow Reconciliation Service', 3006);
