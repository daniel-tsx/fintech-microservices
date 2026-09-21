import 'reflect-metadata';
import { Body, Controller, Get, Injectable, Module, Param, Post, Query, ServiceUnavailableException, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsArray, IsISO8601, IsIn, IsInt, IsOptional, IsPositive, IsString, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { bootstrapService, requiredEnvironment } from '@ledgerflow/platform';
import type { EntryDirection, LedgerJournal } from './ledger.domain.js';
import { createLedgerDatabase } from './database.js';
import { PostgresLedgerRepository } from './postgres-ledger.repository.js';
import { KafkaLedgerConsumer } from './kafka-ledger.consumer.js';

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
class ReconciliationPageQuery {
  @IsISO8601() windowStart!: string;
  @IsISO8601() windowEnd!: string;
  @IsOptional() @IsUUID() after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit = 100;
}

const { client, db } = createLedgerDatabase(requiredEnvironment('DATABASE_URL'));
const ledger = new PostgresLedgerRepository(db);
const consumer = new KafkaLedgerConsumer(
  requiredEnvironment('KAFKA_BROKERS').split(',').map((broker) => broker.trim()),
  ledger,
);
@ApiTags('ledger')
@Controller()
class LedgerController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready')
  async ready() {
    await client`SELECT 1`;
    if (!consumer.isReady()) throw new ServiceUnavailableException({ status: 'not-ready', dependency: 'kafka-consumer' });
    return { status: 'ready', persistence: 'postgresql', messaging: 'redpanda-kafka' };
  }
  @Post('v1/journals') post(@Body() body: JournalDto) { return ledger.postJournal(body); }
  @Get('v1/reconciliation/journals')
  async reconciliationJournals(@Query() query: ReconciliationPageQuery) {
    const data = await ledger.listForReconciliation(new Date(query.windowStart), new Date(query.windowEnd), query.after, query.limit);
    return { data, nextCursor: data.length === query.limit ? data.at(-1)?.id ?? null : null };
  }
  @Get('v1/accounts/:id/balance/:currency')
  async balance(@Param('id') id: string, @Param('currency') currency: string) {
    return { accountId: id, currency, balanceMinor: await ledger.balance(id, currency) };
  }
}

@Injectable()
class LedgerRuntimeLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  async onApplicationBootstrap(): Promise<void> { await consumer.start(); }
  async onApplicationShutdown(): Promise<void> {
    await consumer.stop();
    await client.end({ timeout: 5 });
  }
}

@Module({ controllers: [LedgerController], providers: [LedgerRuntimeLifecycle] })
class LedgerModule {}
void bootstrapService(LedgerModule, 'LedgerFlow Ledger Service', 3005);
