# Idempotency

Status: payment create and domain operations implemented; SQL uniqueness defined.

Clients provide one `Idempotency-Key` per business intent and reuse it for retries. Payment hashes the canonical request. The key and payment are created atomically; the database `PRIMARY KEY` chooses the winner under concurrency. Same key + same hash replays the payment. Same key + different hash fails loudly.

Capture and refund derive their external intent from stable payment/amount identity in the simulator. A production API should persist separate operation idempotency records for multiple partial refunds; the current method contract supports one sequential caller and is a known limitation.

In-flight duplicates should receive `409` or a stable `202` status resource; they must not pass through. Retention must exceed the longest client/event/DLQ retry horizon. Deleting keys after 24 hours while replaying a week-old message would create duplicate money movement.

Implementation: `payment.application.ts`, `in-memory-payment.repository.ts`, and the `idempotency_keys` migration.
