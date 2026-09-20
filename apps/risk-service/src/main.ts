import 'reflect-metadata';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, Length } from 'class-validator';
import { bootstrapService } from '@ledgerflow/platform';
import { DeterministicRiskService } from './risk.service.js';

class RiskRequest {
  @ApiProperty() @IsString() customerId!: string;
  @ApiProperty() @IsInt() @IsPositive() amountMinor!: number;
  @ApiProperty() @IsString() @Length(3, 3) currency!: string;
}

const risk = new DeterministicRiskService({ maximumTransactionMinor: 100_000, maximumDailyAmountMinor: 250_000, maximumDailyCount: 20 });

@ApiTags('risk')
@Controller()
class RiskController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') ready() { return { status: 'ready' }; }
  @Post('v1/risk/evaluations') evaluate(@Body() input: RiskRequest) { return risk.evaluate(input); }
}

@Module({ controllers: [RiskController] })
class RiskModule {}

void bootstrapService(RiskModule, 'LedgerFlow Risk Service', 3003);
