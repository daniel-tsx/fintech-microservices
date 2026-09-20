import type { RiskDecision, RiskPort } from '../../payment-service/src/payment.domain.js';

export interface RiskPolicy {
  maximumTransactionMinor: number;
  maximumDailyAmountMinor: number;
  maximumDailyCount: number;
}

interface ObservedPayment { amountMinor: number; occurredAt: number }

export class DeterministicRiskService implements RiskPort {
  private readonly blockedCustomers = new Set<string>();
  private readonly history = new Map<string, ObservedPayment[]>();
  private readonly decisions = new Map<string, RiskDecision>();

  constructor(private readonly policy: RiskPolicy, private readonly now: () => number = Date.now) {}

  block(customerId: string): void { this.blockedCustomers.add(customerId); }

  async evaluate(input: { paymentId: string; customerId: string; amountMinor: number; currency: string }): Promise<RiskDecision> {
    const prior = this.decisions.get(input.paymentId);
    if (prior !== undefined) return structuredClone(prior);
    const reasons: string[] = [];
    if (this.blockedCustomers.has(input.customerId)) reasons.push('CUSTOMER_BLOCKED');
    if (input.amountMinor > this.policy.maximumTransactionMinor) reasons.push('TRANSACTION_AMOUNT_LIMIT');
    const cutoff = this.now() - 86_400_000;
    const recent = (this.history.get(input.customerId) ?? []).filter((payment) => payment.occurredAt >= cutoff);
    const dailyAmount = recent.reduce((sum, payment) => sum + payment.amountMinor, 0);
    if (recent.length + 1 > this.policy.maximumDailyCount) reasons.push('DAILY_COUNT_LIMIT');
    if (dailyAmount + input.amountMinor > this.policy.maximumDailyAmountMinor) reasons.push('DAILY_AMOUNT_LIMIT');
    if (reasons.length === 0) {
      recent.push({ amountMinor: input.amountMinor, occurredAt: this.now() });
      this.history.set(input.customerId, recent);
    }
    const decision: RiskDecision = { decision: reasons.length === 0 ? 'APPROVE' : 'REJECT', reasonCodes: reasons };
    this.decisions.set(input.paymentId, decision);
    return structuredClone(decision);
  }
}
