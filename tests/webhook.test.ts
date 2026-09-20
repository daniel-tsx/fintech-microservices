import { describe, expect, it } from 'vitest';
import { signWebhook, WebhookVerifier } from '../apps/psp-simulator/src/psp-simulator.js';

describe('webhook verification', () => {
  it('verifies signatures and rejects replay and stale timestamps', () => {
    const now = 1_800_000_000_000;
    const secret = 'test-only-secret';
    const verifier = new WebhookVerifier(secret, 300, () => now);
    const rawBody = JSON.stringify({ type: 'payment.authorized' });
    const timestamp = Math.floor(now / 1000);
    const input = { eventId: crypto.randomUUID(), timestamp, rawBody, signature: signWebhook(secret, timestamp, rawBody) };
    expect(verifier.verify(input)).toBe(true);
    expect(verifier.verify(input)).toBe(false);
    const staleTimestamp = timestamp - 301;
    expect(verifier.verify({ ...input, eventId: crypto.randomUUID(), timestamp: staleTimestamp, signature: signWebhook(secret, staleTimestamp, rawBody) })).toBe(false);
  });
});
