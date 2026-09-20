# ADR 005: Orchestrated transfer saga

Status: accepted.

## Context
A transfer spans wallet reservation, ledger posting, and wallet finalization without 2PC.

## Decision
Use explicit orchestration with persisted-step intent and compensations: release an unposted hold or reverse a posted journal.

## Alternatives
Choreography reduces a central coordinator but hides order and stuck state across consumers. 2PC is operationally inappropriate here.

## Consequences
The orchestrator knows command contracts and needs durable recovery. In return, operators can see the workflow and compensation state.
