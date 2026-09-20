# Messaging

Status: durable Payment-to-Ledger topic wired; other event families remain contracts/learning implementations.

Events use the envelope in `packages/contracts/src/index.ts`: `eventId`, versioned type, timestamp, correlation/causation IDs, aggregate ID, and payload. Topics should be partitioned by aggregate ID so facts about one payment remain ordered.

The active runtime topic is `ledgerflow.payments.v1`, created with three partitions and replication factor one in the single-node local environment. `KafkaMessageProducer` sends with the payment aggregate ID as the key and `acks=-1`. Payment's worker and Ledger's consumer both disable broker auto-topic creation and ensure the declared topic exists. Compose starts Redpanda at `redpanda:9092` internally and `localhost:19092` for host tools.

At-least-once delivery is the only honest end-to-end guarantee: a consumer may apply its database effect and crash before acknowledging Kafka. Therefore consumers claim `eventId` in an inbox in the same local database transaction as their effect. Poison messages use bounded retries, exponential jittered backoff, then a dead-letter table/topic with operator review.

Important facts are `payment.created.v1`, `risk.approved.v1`, `risk.rejected.v1`, `payment.authorized.v1`, `payment.authorization-failed.v1`, `payment.captured.v1`, `payment.refund-requested.v1`, `payment.refunded.v1`, `transfer.requested.v1`, `transfer.completed.v1`, `ledger.entry-posted.v1`, `settlement.created.v1`, and `reconciliation.mismatch-detected.v1`.

Ledger currently applies only `payment.captured.v1`; it validates that event with `paymentCapturedEventSchema` and acknowledges the non-financial payment lifecycle facts without creating journals.

| Event family | Required payload fields |
|---|---|
| Payment lifecycle | `paymentId`, `status`, `amountMinor`, `currency`; create also has `walletId`, `merchantId` |
| Risk decision | `paymentId`, `reasonCodes` |
| Transfer | `transferId`, source/destination wallet IDs, `amountMinor`, `currency` |
| Ledger posted | `journalId`, `referenceType`, `referenceId`, `amountMinor`, `currency` |
| Settlement | `settlementId`, `merchantId`, `netAmountMinor`, `currency`, window |
| Reconciliation mismatch | `discrepancyId`, `paymentId`, `type`, expected/actual summaries |

Schema evolution is additive within version 1. Breaking payload semantics require a new event version and a migration window; consumers ignore unknown additive fields.
