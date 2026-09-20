# ADR 002: Database per service

Status: accepted.

## Context
Shared tables let services bypass contracts and couple deployment.

## Decision
Each service owns a separate PostgreSQL database. Local Compose shares one server only to reduce resource use. No cross-database foreign keys or direct queries.

## Alternatives
A shared database is easier locally but destroys ownership. One PostgreSQL container per service better isolates failure but is noisy for learners.

## Consequences
Cross-service reads require APIs/events and are eventually consistent. Backups, migrations, and credentials can evolve independently.
