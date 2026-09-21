import 'reflect-metadata';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, ServiceUnavailableException, UnauthorizedException, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsIn, IsInt, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, Min, isUUID } from 'class-validator';
import { Type } from 'class-transformer';
import { pspScenarios, type PspScenario } from '@ledgerflow/contracts';
import { bootstrapService, KafkaMessageProducer, requiredEnvironment, structuredLog } from '@ledgerflow/platform';
import { PaymentApplication } from './payment.application.js';
import { IdempotencyMismatchError, PaymentConflictError, PaymentNotFoundError } from './payment.domain.js';
import { InvalidPaymentTransitionError } from './payment-state-machine.js';
import { HttpPspAdapter, HttpRiskAdapter } from './http-adapters.js';
import { createPaymentDatabase } from './database.js';
import { PostgresPaymentRepository } from './postgres-payment.repository.js';
import { PostgresOutboxStore } from './postgres-outbox.store.js';
import { PaymentOutboxWorker } from './outbox.worker.js';
import { PaymentWebhookWorker } from './webhook.worker.js';
import { PaymentRecoveryWorker } from './recovery.worker.js';
import { verifyWebhookSignature } from './webhook-security.js';

class CreatePaymentDto {
  @ApiProperty() @IsUUID() walletId!: string;
  @ApiProperty() @IsUUID() merchantId!: string;
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty() @IsInt() @IsPositive() amountMinor!: number;
  @ApiProperty() @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
}
class AuthorizeDto { @ApiProperty() @IsUUID() customerId!: string }
class RefundDto { @ApiProperty() @IsInt() @IsPositive() amountMinor!: number }
class WebhookDto {
  @ApiProperty() @IsUUID() eventId!: string;
  @ApiProperty({ enum: ['AUTHORIZED', 'CAPTURED', 'REFUNDED', 'DECLINED'] }) @IsIn(['AUTHORIZED', 'CAPTURED', 'REFUNDED', 'DECLINED']) eventType!: 'AUTHORIZED' | 'CAPTURED' | 'REFUNDED' | 'DECLINED';
  @ApiProperty() @IsUUID() operationId!: string;
  @ApiProperty({ enum: ['AUTHORIZE', 'CAPTURE', 'REFUND'] }) @IsIn(['AUTHORIZE', 'CAPTURE', 'REFUND']) operationType!: 'AUTHORIZE' | 'CAPTURE' | 'REFUND';
  @ApiProperty() @IsUUID() paymentId!: string;
  @ApiProperty() @IsUUID() externalPaymentId!: string;
  @ApiProperty() @IsInt() @IsPositive() amountMinor!: number;
  @ApiProperty() @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
  @ApiProperty() @IsInt() @IsPositive() providerSequence!: number;
  @ApiProperty() @IsISO8601() occurredAt!: string;
}
class ReconciliationPageQuery {
  @IsISO8601() windowStart!: string;
  @IsISO8601() windowEnd!: string;
  @IsOptional() @IsUUID() after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit = 100;
}

const { client, db } = createPaymentDatabase(requiredEnvironment('DATABASE_URL'));
const repository = new PostgresPaymentRepository(db);
const application = new PaymentApplication(repository, new HttpRiskAdapter(process.env.RISK_URL ?? 'http://localhost:3003'), new HttpPspAdapter(process.env.PSP_URL ?? 'http://localhost:3004'));
const kafkaBrokers = requiredEnvironment('KAFKA_BROKERS').split(',').map((broker) => broker.trim());
const outboxWorker = new PaymentOutboxWorker(new PostgresOutboxStore(client, `payment-${process.pid}-${crypto.randomUUID()}`), new KafkaMessageProducer('ledgerflow-payment-outbox', kafkaBrokers));
const webhookWorker = new PaymentWebhookWorker(repository, application);
const recoveryWorker = new PaymentRecoveryWorker(repository, application, Number(process.env.PAYMENT_RECOVERY_AGE_MS ?? 2_000));
const webhookSecret = requiredEnvironment('PSP_WEBHOOK_SECRET');
const webhookToleranceSeconds = Number(process.env.PSP_WEBHOOK_TOLERANCE_SECONDS ?? 300);

function correlation(value: string | undefined): string { return value !== undefined && isUUID(value) ? value : crypto.randomUUID(); }
function requestId(value: string | undefined): string { return value !== undefined && isUUID(value) ? value : crypto.randomUUID(); }
function requireIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.length < 8 || value.length > 255) throw new BadRequestException({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key must be 8-255 characters' } });
  return value;
}
function parseScenario(value: string | undefined): PspScenario | undefined {
  if (value === undefined) return undefined;
  if (process.env.ALLOW_PSP_TEST_SCENARIOS !== 'true') throw new BadRequestException({ error: { code: 'PSP_TEST_SCENARIOS_DISABLED', message: 'Deterministic PSP scenarios are disabled in this environment' } });
  if (!(pspScenarios as readonly string[]).includes(value)) throw new BadRequestException({ error: { code: 'INVALID_PSP_SCENARIO', message: 'Unknown deterministic PSP scenario' } });
  return value as PspScenario;
}
function mapError(error: unknown): never {
  if (error instanceof PaymentNotFoundError) throw new NotFoundException({ error: { code: 'PAYMENT_NOT_FOUND', message: error.message } });
  if (error instanceof PaymentConflictError || error instanceof InvalidPaymentTransitionError) throw new ConflictException({ error: { code: 'PAYMENT_STATE_CONFLICT', message: error.message } });
  if (error instanceof IdempotencyMismatchError) throw new BadRequestException({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: error.message } });
  throw error;
}

@ApiTags('payments')
@Controller()
class PaymentController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready')
  async ready() {
    await client`SELECT 1`;
    if (![outboxWorker.isReady(), webhookWorker.isReady(), recoveryWorker.isReady()].every(Boolean)) throw new ServiceUnavailableException({ status: 'not-ready', dependency: 'payment-workers' });
    return { status: 'ready', persistence: 'postgresql', messaging: 'redpanda-kafka' };
  }

  @Post('v1/payments') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@Body() body: CreatePaymentDto, @Headers('idempotency-key') key?: string, @Headers('x-correlation-id') correlationHeader?: string, @Headers('x-request-id') requestHeader?: string) {
    const correlationId = correlation(correlationHeader); const currentRequestId = requestId(requestHeader);
    structuredLog('info', 'payment create request received', { requestId: currentRequestId, correlationId });
    try {
      const payment = await application.create(body, requireIdempotencyKey(key), correlationId);
      structuredLog('info', 'payment and outbox committed', { requestId: currentRequestId, correlationId, paymentId: payment.id });
      return payment;
    } catch (error) { mapError(error); }
  }

  @Get('v1/payments/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) { const payment = await repository.findById(id); if (payment === null) mapError(new PaymentNotFoundError('payment not found')); return payment; }

  @Get('v1/reconciliation/payments')
  async reconciliationPayments(@Query() query: ReconciliationPageQuery) {
    const data = await repository.listForReconciliation(new Date(query.windowStart), new Date(query.windowEnd), query.after, query.limit);
    return { data, nextCursor: data.length === query.limit ? data.at(-1)?.id ?? null : null };
  }

  @Post('v1/payments/:id/authorize')
  async authorize(@Param('id', ParseUUIDPipe) id: string, @Body() body: AuthorizeDto, @Headers('x-correlation-id') correlationId?: string, @Headers('x-test-psp-scenario') scenario?: string) {
    try { return await application.authorize(id, body.customerId, correlation(correlationId), parseScenario(scenario)); } catch (error) { mapError(error); }
  }

  @Post('v1/payments/:id/capture') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async capture(@Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key?: string, @Headers('x-correlation-id') correlationId?: string, @Headers('x-test-psp-scenario') scenario?: string) {
    const currentCorrelationId = correlation(correlationId);
    try {
      const payment = await application.capture(id, requireIdempotencyKey(key), currentCorrelationId, parseScenario(scenario));
      structuredLog('info', 'capture operation resolved', { correlationId: currentCorrelationId, paymentId: payment.id, status: payment.status });
      return payment;
    } catch (error) { mapError(error); }
  }

  @Post('v1/payments/:id/refunds') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async refund(@Param('id', ParseUUIDPipe) id: string, @Body() body: RefundDto, @Headers('idempotency-key') key?: string, @Headers('x-correlation-id') correlationId?: string, @Headers('x-test-psp-scenario') scenario?: string) {
    try { return await application.refund(id, body.amountMinor, requireIdempotencyKey(key), correlation(correlationId), parseScenario(scenario)); } catch (error) { mapError(error); }
  }

  @Post('v1/webhooks/psp') @HttpCode(202)
  async webhook(@Body() body: WebhookDto, @Req() request: { rawBody?: Buffer }, @Headers('x-psp-signature') signature?: string, @Headers('x-psp-timestamp') timestampHeader?: string) {
    const timestamp = Number(timestampHeader); const rawBody = request.rawBody?.toString('utf8');
    if (signature === undefined || rawBody === undefined || !verifyWebhookSignature({ secret: webhookSecret, timestamp, rawBody, signature, toleranceSeconds: webhookToleranceSeconds })) {
      throw new UnauthorizedException({ error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature or timestamp is invalid' } });
    }
    const result = await application.ingestPspWebhook(body);
    structuredLog('info', result === 'ACCEPTED' ? 'PSP webhook durably accepted' : 'duplicate PSP webhook acknowledged', { eventId: body.eventId, paymentId: body.paymentId, operationId: body.operationId });
    return { accepted: true, duplicate: result === 'DUPLICATE' };
  }
}

@Injectable()
class PaymentRuntimeLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  async onApplicationBootstrap(): Promise<void> { await outboxWorker.start(); await webhookWorker.start(); await recoveryWorker.start(); }
  async onApplicationShutdown(): Promise<void> { await recoveryWorker.stop(); await webhookWorker.stop(); await outboxWorker.stop(); await client.end({ timeout: 5 }); }
}

@Module({ controllers: [PaymentController], providers: [PaymentRuntimeLifecycle] })
class PaymentModule {}

void bootstrapService(PaymentModule, 'LedgerFlow Payment Service', 3002);
