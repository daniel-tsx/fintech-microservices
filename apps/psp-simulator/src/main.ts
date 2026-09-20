import 'reflect-metadata';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsPositive, IsString } from 'class-validator';
import { bootstrapService } from '@ledgerflow/platform';
import { PspSimulator, type PspScenario } from './psp-simulator.js';

class OperationRequest {
  @ApiProperty() @IsString() paymentId!: string;
  @ApiProperty() @IsInt() @IsPositive() amountMinor!: number;
  @ApiProperty({ required: false }) @IsString() currency = 'USD';
  @ApiProperty({ required: false }) @IsString() externalPaymentId = '';
}
class ScenarioRequest {
  @ApiProperty({ enum: ['SUCCESS','DECLINE','TIMEOUT_BEFORE_EFFECT','SUCCESS_THEN_TIMEOUT','SLOW_SUCCESS'] })
  @IsIn(['SUCCESS','DECLINE','TIMEOUT_BEFORE_EFFECT','SUCCESS_THEN_TIMEOUT','SLOW_SUCCESS']) scenario!: PspScenario;
}

const simulator = new PspSimulator();

@ApiTags('psp-simulator')
@Controller()
class PspController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') ready() { return { status: 'ready' }; }
  @Post('v1/simulator/scenarios') scenario(@Body() body: ScenarioRequest) { simulator.enqueue(body.scenario); return { accepted: true }; }
  @Post('v1/authorizations') authorize(@Body() body: OperationRequest) { return simulator.authorize(body); }
  @Post('v1/captures') capture(@Body() body: OperationRequest) { return simulator.capture(body); }
  @Post('v1/refunds') refund(@Body() body: OperationRequest) { return simulator.refund(body); }
  @Get('v1/operations') operations() { return { data: simulator.allRecords() }; }
}

@Module({ controllers: [PspController] })
class PspModule {}

void bootstrapService(PspModule, 'LedgerFlow PSP Simulator', 3004);
