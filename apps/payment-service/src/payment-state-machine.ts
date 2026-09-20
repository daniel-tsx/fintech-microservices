import type { PaymentStatus } from '@ledgerflow/contracts';

const transitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  RISK_PENDING: ['RISK_APPROVED', 'RISK_REJECTED', 'CANCELLED'],
  RISK_APPROVED: ['AUTHORIZATION_PENDING', 'CANCELLED'],
  RISK_REJECTED: [],
  AUTHORIZATION_PENDING: ['AUTHORIZED', 'AUTHORIZATION_DECLINED', 'AUTHORIZATION_FAILED', 'AUTHORIZATION_UNKNOWN', 'CAPTURED'],
  AUTHORIZATION_UNKNOWN: ['AUTHORIZATION_PENDING', 'AUTHORIZED', 'AUTHORIZATION_DECLINED', 'AUTHORIZATION_FAILED', 'CAPTURED'],
  AUTHORIZATION_FAILED: ['AUTHORIZATION_PENDING', 'CANCELLED'],
  AUTHORIZATION_DECLINED: [],
  AUTHORIZED: ['CAPTURE_PENDING', 'CAPTURED', 'CANCELLED'],
  CAPTURE_PENDING: ['CAPTURED', 'CAPTURE_FAILED', 'CAPTURE_UNKNOWN'],
  CAPTURE_UNKNOWN: ['CAPTURE_PENDING', 'CAPTURED', 'CAPTURE_FAILED'],
  CAPTURE_FAILED: ['CAPTURE_PENDING', 'CANCELLED'],
  CAPTURED: ['REFUND_PENDING'],
  REFUND_PENDING: ['PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED', 'REFUND_UNKNOWN'],
  REFUND_UNKNOWN: ['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'],
  REFUND_FAILED: ['REFUND_PENDING'],
  PARTIALLY_REFUNDED: ['REFUND_PENDING'],
  REFUNDED: [],
  CANCELLED: [],
};

export const terminalPaymentStatuses: readonly PaymentStatus[] = ['RISK_REJECTED', 'AUTHORIZATION_DECLINED', 'REFUNDED', 'CANCELLED'];
export const recoverablePaymentStatuses: readonly PaymentStatus[] = ['AUTHORIZATION_UNKNOWN', 'CAPTURE_UNKNOWN', 'REFUND_UNKNOWN'];

export class InvalidPaymentTransitionError extends Error {
  constructor(readonly from: PaymentStatus, readonly to: PaymentStatus) {
    super(`invalid payment transition ${from} -> ${to}`);
  }
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!transitions[from].includes(to)) throw new InvalidPaymentTransitionError(from, to);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return transitions[from].includes(to);
}

export function allowedTransitions(status: PaymentStatus): readonly PaymentStatus[] {
  return transitions[status];
}
