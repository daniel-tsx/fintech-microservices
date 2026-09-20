import 'reflect-metadata';
import { Body, ConflictException, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, IsUUID } from 'class-validator';
import { bootstrapService } from '@ledgerflow/platform';
import { InsufficientFundsError, WalletBook } from './wallet.domain.js';

class CreateWalletDto {
  @ApiProperty() @IsUUID() id!: string;
  @ApiProperty() @IsUUID() ownerId!: string;
  @ApiProperty() @IsString() currency!: string;
  @ApiProperty() @IsInt() @IsPositive() openingBalanceMinor!: number;
}
class AmountDto { @ApiProperty() @IsUUID() operationId!: string; @ApiProperty() @IsInt() @IsPositive() amountMinor!: number; }

const wallets = new WalletBook();

@ApiTags('wallets')
@Controller()
class WalletController {
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') ready() { return { status: 'ready', persistence: 'in-memory-learning-adapter' }; }
  @Post('v1/wallets') create(@Body() body: CreateWalletDto) { wallets.add({ id: body.id, ownerId: body.ownerId, currency: body.currency, availableMinor: body.openingBalanceMinor, pendingMinor: 0, version: 0 }); return wallets.get(body.id); }
  @Get('v1/wallets/:id') get(@Param('id') id: string) { return wallets.get(id); }
  @Post('v1/wallets/:id/reservations')
  async reserve(@Param('id') id: string, @Body() body: AmountDto) { try { return await wallets.reserve(id, body.operationId, body.amountMinor); } catch (error) { if (error instanceof InsufficientFundsError) throw new ConflictException({ error: { code: 'INSUFFICIENT_FUNDS', message: error.message } }); throw error; } }
  @Post('v1/wallets/:id/credits') credit(@Param('id') id: string, @Body() body: AmountDto) { return wallets.credit(id, body.operationId, body.amountMinor); }
}

@Module({ controllers: [WalletController] })
class WalletModule {}
void bootstrapService(WalletModule, 'LedgerFlow Wallet Service', 3001);
