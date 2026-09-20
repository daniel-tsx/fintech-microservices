import { describe, expect, it } from 'vitest';
import { WalletBook } from '../apps/wallet-service/src/wallet.domain.js';
import { TransferSaga, type TransferLedgerPort } from '../apps/wallet-service/src/transfer.saga.js';

describe('transfer saga compensation', () => {
  it('releases held funds when ledger posting fails', async () => {
    const wallets = new WalletBook();
    const source = crypto.randomUUID();
    const destination = crypto.randomUUID();
    wallets.add({ id: source, ownerId: crypto.randomUUID(), currency: 'USD', availableMinor: 1000, pendingMinor: 0, version: 0 });
    wallets.add({ id: destination, ownerId: crypto.randomUUID(), currency: 'USD', availableMinor: 0, pendingMinor: 0, version: 0 });
    const ledger: TransferLedgerPort = { postTransfer: () => Promise.reject(new Error('ledger unavailable')), reverseTransfer: () => Promise.resolve() };
    const result = await new TransferSaga(wallets, ledger).execute({ id: crypto.randomUUID(), sourceWalletId: source, destinationWalletId: destination, amountMinor: 600, currency: 'USD', status: 'REQUESTED', failureReason: null });
    expect(result.status).toBe('FAILED');
    expect(wallets.get(source)).toMatchObject({ availableMinor: 1000, pendingMinor: 0 });
    expect(wallets.get(destination).availableMinor).toBe(0);
  });

  it('revokes a destination credit and reverses the journal when finalization fails', async () => {
    class FailingCommitWalletBook extends WalletBook {
      override commit(): Promise<never> { return Promise.reject(new Error('wallet commit unavailable')); }
    }
    const wallets = new FailingCommitWalletBook();
    const source = crypto.randomUUID();
    const destination = crypto.randomUUID();
    wallets.add({ id: source, ownerId: crypto.randomUUID(), currency: 'USD', availableMinor: 1000, pendingMinor: 0, version: 0 });
    wallets.add({ id: destination, ownerId: crypto.randomUUID(), currency: 'USD', availableMinor: 0, pendingMinor: 0, version: 0 });
    let reversed = false;
    const ledger: TransferLedgerPort = { postTransfer: () => Promise.resolve('journal-1'), reverseTransfer: () => { reversed = true; return Promise.resolve(); } };
    const result = await new TransferSaga(wallets, ledger).execute({ id: crypto.randomUUID(), sourceWalletId: source, destinationWalletId: destination, amountMinor: 600, currency: 'USD', status: 'REQUESTED', failureReason: null });
    expect(result.status).toBe('FAILED');
    expect(reversed).toBe(true);
    expect(wallets.get(source)).toMatchObject({ availableMinor: 1000, pendingMinor: 0 });
    expect(wallets.get(destination).availableMinor).toBe(0);
  });
});
