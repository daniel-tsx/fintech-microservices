import { createHmac, timingSafeEqual } from 'node:crypto';

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyWebhookSignature(input: { secret: string; timestamp: number; rawBody: string; signature: string; toleranceSeconds: number; now?: number }): boolean {
  const now = input.now ?? Date.now();
  if (!Number.isInteger(input.timestamp) || Math.abs(Math.floor(now / 1000) - input.timestamp) > input.toleranceSeconds) return false;
  if (!/^[a-fA-F0-9]{64}$/.test(input.signature)) return false;
  const expected = Buffer.from(signWebhook(input.secret, input.timestamp, input.rawBody), 'hex');
  const actual = Buffer.from(input.signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
