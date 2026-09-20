# ADR 007: Integer minor units

Status: accepted.

## Context
Binary floating point cannot exactly represent common decimal money values.

## Decision
Represent amounts as positive safe integers in TypeScript and `bigint` in PostgreSQL, always paired with ISO currency. Validate before arithmetic.

## Alternatives
PostgreSQL `numeric` is exact but requires string/decimal-library handling in JavaScript. Floating point is unsafe. A decimal library is appropriate when fractional minor units or FX arrive.

## Consequences
Simple exact arithmetic and JSON contracts, bounded by JavaScript's safe-integer range. Currency exponent and FX conversion need explicit future policy.
