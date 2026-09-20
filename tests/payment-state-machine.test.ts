import { describe, expect, it } from 'vitest';
import { InvalidPaymentTransitionError, allowedTransitions, assertPaymentTransition, canTransition } from '../apps/payment-service/src/payment-state-machine.js';

describe('payment state machine', () => {
  it('allows the explicit happy path and recoverable unknown retry paths', () => {
    const transitions = [
      ['RISK_PENDING', 'RISK_APPROVED'],
      ['RISK_APPROVED', 'AUTHORIZATION_PENDING'],
      ['AUTHORIZATION_PENDING', 'AUTHORIZATION_UNKNOWN'],
      ['AUTHORIZATION_UNKNOWN', 'AUTHORIZATION_PENDING'],
      ['AUTHORIZATION_PENDING', 'AUTHORIZED'],
      ['AUTHORIZED', 'CAPTURE_PENDING'],
      ['CAPTURE_PENDING', 'CAPTURED'],
      ['CAPTURED', 'REFUND_PENDING'],
      ['REFUND_PENDING', 'PARTIALLY_REFUNDED'],
      ['PARTIALLY_REFUNDED', 'REFUND_PENDING'],
      ['REFUND_PENDING', 'REFUNDED'],
    ] as const;
    for (const [from, to] of transitions) expect(() => assertPaymentTransition(from, to)).not.toThrow();
  });

  it('rejects regressions and movement out of terminal states', () => {
    expect(canTransition('CAPTURED', 'AUTHORIZED')).toBe(false);
    expect(allowedTransitions('REFUNDED')).toEqual([]);
    expect(() => assertPaymentTransition('REFUNDED', 'REFUND_PENDING')).toThrow(InvalidPaymentTransitionError);
    expect(() => assertPaymentTransition('AUTHORIZATION_DECLINED', 'AUTHORIZATION_PENDING')).toThrow(InvalidPaymentTransitionError);
  });
});
