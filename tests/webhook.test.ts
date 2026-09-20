import { describe, expect, it } from 'vitest';
import { signWebhook, WebhookVerifier } from '../apps/psp-simulator/src/psp-simulator.js';

describe('webhook verification', () => {
  it('authenticates signatures without keeping process-local replay state', () => {
    const now = 1_800_000_000_000;
    const secret = 'test-only-secret';
    const verifier = new WebhookVerifier(secret, 300, () => now);
    const rawBody = JSON.stringify({ type: 'payment.authorized' });
    const timestamp = Math.floor(now / 1000);
    const input = { timestamp, rawBody, signature: signWebhook(secret, timestamp, rawBody) };
    expect(verifier.verify(input)).toBe(true);
    expect(verifier.verify(input)).toBe(true);
    expect(verifier.verify({ ...input, signature: '0'.repeat(64) })).toBe(false);
    const staleTimestamp = timestamp - 301;
    expect(verifier.verify({ timestamp: staleTimestamp, rawBody, signature: signWebhook(secret, staleTimestamp, rawBody) })).toBe(false);
  });
});
