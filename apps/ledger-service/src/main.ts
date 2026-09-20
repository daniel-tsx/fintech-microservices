import 'reflect-metadata';
import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsPositive, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { bootstrapService } from '@ledgerflow/platform';
import { Ledger, type EntryDirection, type LedgerJournal } from './ledger.domain.js';

class EntryDto {
  @ApiProperty() @IsUUID() accountId!: string;
  @ApiProperty({ enum: ['DEBIT','CREDIT'] }) @IsIn(['DEBIT','CREDIT']) direction!: EntryDirection;
  @ApiProperty() @IsInt() @IsPositive() amountMinor!: number;
  @ApiProperty() @IsString() currency!: string;
}
class JournalDto {
  @ApiProperty() @IsIn(['PAYMENT','REFUND','TRANSFER','SETTLEMENT','REVERSAL']) referenceType!: LedgerJournal['referenceType'];
  @ApiProperty() @IsUUID() referenceId!: string;
  @ApiProperty() @IsUUID() correlationId!: string;
  @ApiProperty({ type: [EntryDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => EntryDto) entries!: EntryDto[];
}

const ledger = new Ledger();
@ApiTags('ledger')
@Controller()
class LedgerController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') ready() { return { status: 'ready', persistence: 'in-memory-learning-adapter' }; }
  @Post('v1/journals') post(@Body() body: JournalDto) { return ledger.post(body); }
  @Get('v1/accounts/:id/balance/:currency') balance(@Param('id') id: string, @Param('currency') currency: string) { return { accountId: id, currency, balanceMinor: ledger.balance(id, currency) }; }
}
@Module({ controllers: [LedgerController] })
class LedgerModule {}
void bootstrapService(LedgerModule, 'LedgerFlow Ledger Service', 3005);
