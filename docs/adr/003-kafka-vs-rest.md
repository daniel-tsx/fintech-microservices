# ADR 003: REST and Kafka-compatible events

Status: accepted.

## Context
Not every interaction benefits from asynchronous messaging.

## Decision
Use REST for decisions needed immediately (risk, PSP commands) and Redpanda events for independently consumed facts (captured, ledger posted, mismatch). Do not add gRPC yet.

## Alternatives
Events-only turns request/response into correlation machinery. REST-only tightly couples downstream availability and loses replay.

## Consequences
Two failure models must be understood. REST timeouts can be unknown; events are at-least-once and require inboxes.
