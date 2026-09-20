import type { WalletBook } from './wallet.domain.js';

export type TransferStatus = 'REQUESTED' | 'FUNDS_HELD' | 'LEDGER_POSTED' | 'COMPLETED' | 'COMPENSATING' | 'FAILED';
export interface Transfer {
  id: string;
  sourceWalletId: string;
  destinationWalletId: string;
  amountMinor: number;
  currency: string;
  status: TransferStatus;
  failureReason: string | null;
}

export interface TransferLedgerPort {
  postTransfer(transfer: Transfer): Promise<string>;
  reverseTransfer(journalId: string, transfer: Transfer): Promise<void>;
}

export class TransferSaga {
  constructor(private readonly wallets: WalletBook, private readonly ledger: TransferLedgerPort) {}

  async execute(transfer: Transfer): Promise<Transfer> {
    try {
      await this.wallets.reserve(transfer.sourceWalletId, transfer.id, transfer.amountMinor);
      transfer.status = 'FUNDS_HELD';
      const journalId = await this.ledger.postTransfer(transfer);
      transfer.status = 'LEDGER_POSTED';
      let destinationCredited = false;
      try {
        await this.wallets.credit(transfer.destinationWalletId, transfer.id, transfer.amountMinor);
        destinationCredited = true;
        await this.wallets.commit(transfer.id);
        transfer.status = 'COMPLETED';
        return transfer;
      } catch (error) {
        transfer.status = 'COMPENSATING';
        if (destinationCredited) await this.wallets.revokeCredit(transfer.destinationWalletId, transfer.id);
        await this.ledger.reverseTransfer(journalId, transfer);
        await this.wallets.release(transfer.id);
        throw error;
      }
    } catch (error) {
      if (transfer.status === 'FUNDS_HELD') await this.wallets.release(transfer.id);
      transfer.status = 'FAILED';
      transfer.failureReason = error instanceof Error ? error.message : 'unknown transfer failure';
      return transfer;
    }
  }
}
