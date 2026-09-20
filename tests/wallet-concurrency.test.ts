import { describe, expect, it } from 'vitest';
import { InsufficientFundsError, WalletBook } from '../apps/wallet-service/src/wallet.domain.js';

describe('wallet concurrency', () => {
  it('allows only one concurrent spend of the same funds', async () => {
    const book = new WalletBook();
    const walletId = crypto.randomUUID();
    book.add({ id: walletId, ownerId: crypto.randomUUID(), currency: 'USD', availableMinor: 1000, pendingMinor: 0, version: 0 });
    const results = await Promise.allSettled([
      book.reserve(walletId, crypto.randomUUID(), 800),
      book.reserve(walletId, crypto.randomUUID(), 800),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(InsufficientFundsError);
    expect(book.get(walletId)).toMatchObject({ availableMinor: 200, pendingMinor: 800 });
  });

  it('replays the same reservation without holding twice', async () => {
    const book = new WalletBook();
    const walletId = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    book.add({ id: walletId, ownerId: crypto.randomUUID(), currency: 'USD', availableMinor: 1000, pendingMinor: 0, version: 0 });
    await book.reserve(walletId, reservationId, 400);
    await book.reserve(walletId, reservationId, 400);
    expect(book.get(walletId)).toMatchObject({ availableMinor: 600, pendingMinor: 400 });
  });
});
