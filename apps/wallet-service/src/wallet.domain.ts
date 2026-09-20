export interface Wallet {
  id: string;
  ownerId: string;
  currency: string;
  availableMinor: number;
  pendingMinor: number;
  version: number;
}

export class InsufficientFundsError extends Error {}
export class WalletNotFoundError extends Error {}
export class DuplicateReservationError extends Error {}

export class WalletBook {
  private readonly wallets = new Map<string, Wallet>();
  private readonly reservations = new Map<string, { walletId: string; amountMinor: number; state: 'HELD' | 'COMMITTED' | 'RELEASED' }>();
  private tail: Promise<void> = Promise.resolve();

  add(wallet: Wallet): void {
    if (!Number.isSafeInteger(wallet.availableMinor) || wallet.availableMinor < 0 || wallet.pendingMinor < 0) throw new RangeError('invalid wallet balance');
    this.wallets.set(wallet.id, structuredClone(wallet));
  }

  async reserve(walletId: string, reservationId: string, amountMinor: number): Promise<Wallet> {
    return this.exclusive(async () => {
      this.assertAmount(amountMinor);
      const existing = this.reservations.get(reservationId);
      if (existing !== undefined) {
        if (existing.walletId !== walletId || existing.amountMinor !== amountMinor) throw new DuplicateReservationError('reservation id reused with another intent');
        return this.requireWallet(walletId);
      }
      const wallet = this.requireWallet(walletId);
      if (wallet.availableMinor < amountMinor) throw new InsufficientFundsError('insufficient available balance');
      const next = { ...wallet, availableMinor: wallet.availableMinor - amountMinor, pendingMinor: wallet.pendingMinor + amountMinor, version: wallet.version + 1 };
      this.wallets.set(walletId, next);
      this.reservations.set(reservationId, { walletId, amountMinor, state: 'HELD' });
      return structuredClone(next);
    });
  }

  async commit(reservationId: string): Promise<Wallet> {
    return this.exclusive(async () => {
      const reservation = this.requireReservation(reservationId);
      const wallet = this.requireWallet(reservation.walletId);
      if (reservation.state === 'COMMITTED') return wallet;
      if (reservation.state === 'RELEASED') throw new DuplicateReservationError('released reservation cannot be committed');
      reservation.state = 'COMMITTED';
      const next = { ...wallet, pendingMinor: wallet.pendingMinor - reservation.amountMinor, version: wallet.version + 1 };
      this.wallets.set(wallet.id, next);
      return structuredClone(next);
    });
  }

  async release(reservationId: string): Promise<Wallet> {
    return this.exclusive(async () => {
      const reservation = this.requireReservation(reservationId);
      const wallet = this.requireWallet(reservation.walletId);
      if (reservation.state === 'RELEASED') return wallet;
      if (reservation.state === 'COMMITTED') throw new DuplicateReservationError('committed reservation requires a ledger reversal');
      reservation.state = 'RELEASED';
      const next = { ...wallet, pendingMinor: wallet.pendingMinor - reservation.amountMinor, availableMinor: wallet.availableMinor + reservation.amountMinor, version: wallet.version + 1 };
      this.wallets.set(wallet.id, next);
      return structuredClone(next);
    });
  }

  async credit(walletId: string, transferId: string, amountMinor: number): Promise<Wallet> {
    return this.exclusive(async () => {
      this.assertAmount(amountMinor);
      const key = `credit:${transferId}`;
      const prior = this.reservations.get(key);
      const wallet = this.requireWallet(walletId);
      if (prior !== undefined) return wallet;
      this.reservations.set(key, { walletId, amountMinor, state: 'COMMITTED' });
      const next = { ...wallet, availableMinor: wallet.availableMinor + amountMinor, version: wallet.version + 1 };
      this.wallets.set(walletId, next);
      return structuredClone(next);
    });
  }

  async revokeCredit(walletId: string, transferId: string): Promise<Wallet> {
    return this.exclusive(async () => {
      const key = `credit:${transferId}`;
      const credit = this.requireReservation(key);
      const wallet = this.requireWallet(walletId);
      if (credit.walletId !== walletId) throw new DuplicateReservationError('credit belongs to another wallet');
      if (credit.state === 'RELEASED') return wallet;
      if (wallet.availableMinor < credit.amountMinor) throw new InsufficientFundsError('credited funds were already spent; manual repair required');
      credit.state = 'RELEASED';
      const next = { ...wallet, availableMinor: wallet.availableMinor - credit.amountMinor, version: wallet.version + 1 };
      this.wallets.set(walletId, next);
      return structuredClone(next);
    });
  }

  get(walletId: string): Wallet { return this.requireWallet(walletId); }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private requireWallet(id: string): Wallet {
    const wallet = this.wallets.get(id);
    if (wallet === undefined) throw new WalletNotFoundError(`wallet ${id} not found`);
    return structuredClone(wallet);
  }

  private requireReservation(id: string) {
    const reservation = this.reservations.get(id);
    if (reservation === undefined) throw new Error(`reservation ${id} not found`);
    return reservation;
  }

  private assertAmount(amountMinor: number): void {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError('amountMinor must be a positive safe integer');
  }
}
