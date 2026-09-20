# ADR 001: Service boundaries

Status: accepted.

## Context
The project must teach meaningful ownership without deploying empty CRUD services.

## Decision
Implement Payment, Wallet, Ledger, Risk, PSP, and Reconciliation as bounded contexts. Keep Ledger separate from Payment. Defer Identity, Customer, Notification, API Gateway, and standalone Settlement until their behavior is meaningful.

## Alternatives
One modular monolith would simplify consistency but hide distributed failure. Ten mandatory services would create artificial network calls and boilerplate.

## Consequences
The core failure paths remain visible with manageable local infrastructure. Some requested platform edges are documented rather than executable in this first slice.
