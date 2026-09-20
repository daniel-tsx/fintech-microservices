# Webhooks

Status: verification and payment resolution implemented.

The payment endpoint verifies an HMAC-SHA256 over `timestamp.rawBody`, rejects timestamps outside five minutes, compares signatures in constant time, and remembers event IDs to prevent replay. The domain repository also supports an inbox-backed atomic transition for duplicate deliveries.

Webhooks may arrive before the synchronous PSP response, more than once, late, or out of order. Handlers therefore apply only legal monotonic transitions: a capture webhook can advance an authorization-pending payment directly to captured; an old authorization after capture is a no-op. Unknown event types should be acknowledged and quarantined for inspection rather than endlessly retried.

A hardened endpoint should verify and enqueue durably, return `2xx` quickly, and process asynchronously. Doing slow business work before acknowledging causes provider retry storms. Raw-body capture must happen before JSON mutation; secrets come from a secret manager/environment, never source.
