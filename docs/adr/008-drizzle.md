# ADR 008: Drizzle over Prisma

Status: accepted for the durable-adapter slice.

## Context
The repository needs typed PostgreSQL access while keeping SQL/concurrency behavior visible to learners.

## Decision
Use Drizzle for typed schemas and parameterized queries. Keep reviewed SQL migrations and allow explicit SQL for conditional updates, row locks, and outbox claims.

## Alternatives
Prisma offers a polished client but can obscure exact locking/query semantics central to this curriculum. Raw SQL alone loses typed schema assistance.

## Consequences
Learners must understand both Drizzle and SQL. Payment and Ledger now use Drizzle/PostgreSQL runtime repositories, while explicit SQL remains visible for leases, inbox conflicts, and deferred balance constraints. Other services retain their earlier adapters until their own focused durability slices.
