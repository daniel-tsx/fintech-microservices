import 'reflect-metadata';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Module, NotFoundException, Param, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, IsUUID, Length } from 'class-validator';
import { bootstrapService } from '@ledgerflow/platform';
import { InMemoryPaymentRepository } from './in-memory-payment.repository.js';
import { PaymentApplication } from './payment.application.js';
import { IdempotencyMismatchError, PaymentConflictError, PaymentNotFoundError } from './payment.domain.js';
import { HttpPspAdapter, HttpRiskAdapter } from './http-adapters.js';
import { WebhookVerifier } from '../../psp-simulator/src/psp-simulator.js';

class CreatePaymentDto {
  @ApiProperty() @IsUUID() walletId!: string;
  @ApiProperty() @IsUUID() merchantId!: string;
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty() @IsInt() @IsPositive() amountMinor!: number;
  @ApiProperty() @IsString() @Length(3, 3) currency!: string;
}
class AuthorizeDto { @ApiProperty() @IsUUID() customerId!: string; }
class RefundDto { @ApiProperty() @IsInt() @IsPositive() amountMinor!: number; }
class WebhookDto {
  @ApiProperty() @IsUUID() eventId!: string;
  @ApiProperty() @IsUUID() paymentId!: string;
  @ApiProperty() @IsString() outcome!: 'AUTHORIZED' | 'CAPTURED' | 'REFUNDED' | 'DECLINED';
  @ApiProperty() @IsUUID() externalPaymentId!: string;
}

const repository = new InMemoryPaymentRepository();
const application = new PaymentApplication(
  repository,
  new HttpRiskAdapter(process.env.RISK_URL ?? 'http://localhost:3003'),
  new HttpPspAdapter(process.env.PSP_URL ?? 'http://localhost:3004'),
);
const webhookSecret = process.env.PSP_WEBHOOK_SECRET;
const webhookVerifier = webhookSecret === undefined ? null : new WebhookVerifier(webhookSecret);

function correlation(value: string | undefined): string { return value === undefined ? crypto.randomUUID() : value; }
function mapError(error: unknown): never {
  if (error instanceof PaymentNotFoundError) throw new NotFoundException({ error: { code: 'PAYMENT_NOT_FOUND', message: error.message } });
  if (error instanceof PaymentConflictError) throw new ConflictException({ error: { code: 'PAYMENT_STATE_CONFLICT', message: error.message } });
  if (error instanceof IdempotencyMismatchError) throw new BadRequestException({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: error.message } });
  throw error;
}

@ApiTags('payments')
@Controller()
class PaymentController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') ready() { return { status: 'ready', persistence: 'in-memory-learning-adapter' }; }

  @Post('v1/payments') @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@Body() body: CreatePaymentDto, @Headers('idempotency-key') key?: string, @Headers('x-correlation-id') id?: string) {
    if (key === undefined || key.length < 8) throw new BadRequestException({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key must be at least 8 characters' } });
    try { return await application.create(body, key, correlation(id)); } catch (error) { mapError(error); }
  }

  @Get('v1/payments/:id')
  async get(@Param('id') id: string) { const payment = await repository.findById(id); if (payment === null) mapError(new PaymentNotFoundError('payment not found')); return payment; }

  @Post('v1/payments/:id/authorize')
  async authorize(@Param('id') id: string, @Body() body: AuthorizeDto, @Headers('x-correlation-id') correlationId?: string) {
    try { return await application.authorize(id, body.customerId, correlation(correlationId)); } catch (error) { mapError(error); }
  }

  @Post('v1/payments/:id/capture')
  async capture(@Param('id') id: string, @Headers('x-correlation-id') correlationId?: string) {
    try { return await application.capture(id, correlation(correlationId)); } catch (error) { mapError(error); }
  }

  @Post('v1/payments/:id/refunds')
  async refund(@Param('id') id: string, @Body() body: RefundDto, @Headers('x-correlation-id') correlationId?: string) {
    try { return await application.refund(id, body.amountMinor, correlation(correlationId)); } catch (error) { mapError(error); }
  }

  @Post('v1/webhooks/psp')
  async webhook(
    @Body() body: WebhookDto,
    @Req() request: { rawBody?: Buffer },
    @Headers('x-psp-signature') signature?: string,
    @Headers('x-psp-timestamp') timestampHeader?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (webhookVerifier === null) throw new ServiceUnavailableException({ error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook secret is not configured' } });
    const timestamp = Number(timestampHeader);
    const rawBody = request.rawBody?.toString('utf8');
    if (signature === undefined || !Number.isInteger(timestamp) || rawBody === undefined || !webhookVerifier.verify({ eventId: body.eventId, timestamp, rawBody, signature })) {
      throw new UnauthorizedException({ error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature, timestamp, or replay check failed' } });
    }
    return application.applyPspWebhook({ ...body, correlationId: correlation(correlationId) });
  }
}

@Module({ controllers: [PaymentController] })
class PaymentModule {}

void bootstrapService(PaymentModule, 'LedgerFlow Payment Service', 3002);
