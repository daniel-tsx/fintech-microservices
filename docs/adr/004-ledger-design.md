# ADR 004: Append-only double-entry ledger

Status: accepted.

## Context
Mutable balance rows cannot explain history or prove conservation of money.

## Decision
Use immutable balanced journals and entries. Corrections append reversals. Wallet balances remain operational projections.

## Alternatives
Single-entry transaction rows are simpler but cannot express counter-accounts. Mutating past entries erases audit evidence.

## Consequences
Reads require aggregation/snapshots and account semantics require care, but every movement is attributable and balanceable.
