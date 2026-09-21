import 'reflect-metadata';
import { BadRequestException, Body, Controller, Get, Headers, Injectable, Module, NotFoundException, Param, Post, Query, ServiceUnavailableException, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsIn, IsInt, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { bootstrapService, requiredEnvironment } from '@ledgerflow/platform';
import { pspScenarios, type PspScenario } from '@ledgerflow/contracts';
import { createPspDatabase } from './database.js';
import { PostgresPspRepository, PspHttpError } from './postgres-psp.repository.js';
import { DurablePspWebhookScheduler, PspWebhookWorker } from './webhook.worker.js';
import { statementScenarios, type StatementScenario } from './settlement-statement.js';

class OperationRequest {
  @ApiProperty() @IsUUID() operationId!: string;
  @ApiProperty() @IsUUID() paymentId!: string;
  @ApiProperty() @IsInt() @IsPositive() amountMinor!: number;
  @ApiProperty() @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() externalPaymentId?: string;
  @ApiProperty({ required: false, enum: pspScenarios }) @IsOptional() @IsIn(pspScenarios) scenario?: PspScenario;
}
class ScenarioRequest { @ApiProperty({ enum: pspScenarios }) @IsIn(pspScenarios) scenario!: PspScenario }
class StatementRequest {
  @ApiProperty() @IsString() @Length(1, 128) providerSettlementId!: string;
  @ApiProperty() @IsISO8601() windowStart!: string;
  @ApiProperty() @IsISO8601() windowEnd!: string;
  @ApiProperty() @Matches(/^[A-Z]{3}$/) currency!: string;
  @ApiProperty({ enum: statementScenarios, required: false }) @IsOptional() @IsIn(statementScenarios) scenario?: StatementScenario;
}
class ReconciliationPageQuery {
  @IsISO8601() windowStart!: string;
  @IsISO8601() windowEnd!: string;
  @IsOptional() @IsUUID() after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit = 100;
}

const { client, db } = createPspDatabase(requiredEnvironment('DATABASE_URL'));
const scheduler = new DurablePspWebhookScheduler(db, requiredEnvironment('PAYMENT_WEBHOOK_URL'), requiredEnvironment('PSP_WEBHOOK_SECRET'));
const repository = new PostgresPspRepository(db, scheduler);
const worker = new PspWebhookWorker(client, db, scheduler);
const statementSecret = requiredEnvironment('PSP_STATEMENT_SECRET');
let queuedScenario: PspScenario | undefined;

async function execute(operation: 'AUTHORIZE' | 'CAPTURE' | 'REFUND', body: OperationRequest, key?: string) {
  if (key !== body.operationId) throw new BadRequestException({ error: { code: 'PSP_IDEMPOTENCY_KEY_MISMATCH', message: 'Idempotency-Key must equal operationId' } });
  const scenario = body.scenario ?? queuedScenario;
  const input = { ...body, ...(scenario === undefined ? {} : { scenario }) };
  queuedScenario = undefined;
  try {
    return operation === 'AUTHORIZE' ? await repository.authorize(input) : operation === 'CAPTURE' ? await repository.capture(input) : await repository.refund(input);
  } catch (error) {
    if (error instanceof PspHttpError) throw new ServiceUnavailableException({ error: { code: 'SIMULATED_PSP_500', message: error.message } });
    throw error;
  }
}

@ApiTags('psp-simulator')
@Controller()
class PspController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') async ready() { await client`SELECT 1`; return { status: 'ready', persistence: 'postgresql' }; }
  @Post('v1/simulator/scenarios') scenario(@Body() body: ScenarioRequest) { queuedScenario = body.scenario; return { accepted: true }; }
  @Post('v1/authorizations') authorize(@Body() body: OperationRequest, @Headers('idempotency-key') key?: string) { return execute('AUTHORIZE', body, key); }
  @Post('v1/captures') capture(@Body() body: OperationRequest, @Headers('idempotency-key') key?: string) { return execute('CAPTURE', body, key); }
  @Post('v1/refunds') refund(@Body() body: OperationRequest, @Headers('idempotency-key') key?: string) { return execute('REFUND', body, key); }
  @Get('v1/provider-transactions/:operationId') async status(@Param('operationId') operationId: string) { const result = await repository.query(operationId); if (result.outcome === 'NOT_FOUND') throw new NotFoundException(); return result; }
  @Get('v1/operations') async operations() { return { data: await repository.allRecords() }; }
  @Get('v1/reconciliation/operations') async reconciliationOperations(@Query() query: ReconciliationPageQuery) {
    const data = await repository.listForReconciliation(new Date(query.windowStart), new Date(query.windowEnd), query.after, query.limit);
    return { data, nextCursor: data.length === query.limit ? data.at(-1)?.operationId ?? null : null };
  }
  @Post('v1/settlement-statements') async createStatement(@Body() body: StatementRequest) { return repository.generateStatement(body, statementSecret); }
  @Get('v1/settlement-statements/:id') async statement(@Param('id') id: string) { const statement = await repository.findStatement(id); if (statement === null) throw new NotFoundException(); return statement; }
}

@Injectable()
class PspLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  async onApplicationBootstrap(): Promise<void> { await worker.start(); }
  async onApplicationShutdown(): Promise<void> { await worker.stop(); await client.end({ timeout: 5 }); }
}

@Module({ controllers: [PspController], providers: [PspLifecycle] })
class PspModule {}

void bootstrapService(PspModule, 'LedgerFlow PSP Simulator', 3004);
