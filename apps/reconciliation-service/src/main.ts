import 'reflect-metadata';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { bootstrapService } from '@ledgerflow/platform';
import { ReconciliationService } from './reconciliation.service.js';

const service = new ReconciliationService();
@ApiTags('reconciliation')
@Controller()
class ReconciliationController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') ready() { return { status: 'ready', persistence: 'in-memory-learning-adapter' }; }
  @Post('v1/reconciliation/runs')
  run(@Body() body: Parameters<ReconciliationService['reconcile']> extends [infer P, infer E, infer L] ? { payments: P; pspRecords: E; ledgerJournals: L } : never) {
    return { discrepancies: service.reconcile(body.payments, body.pspRecords, body.ledgerJournals) };
  }
}
@Module({ controllers: [ReconciliationController] })
class ReconciliationModule {}
void bootstrapService(ReconciliationModule, 'LedgerFlow Reconciliation Service', 3006);
