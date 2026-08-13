# Data Model: Hello World Greeting

**Feature**: `002-hello-world-greeting` | **Branch**: `spec/issue-94` | **Date**: 2026-08-14

## Entities

### Greeting

The greeting text returned to the user.

| Field | Type | Constraints | Source |
|-------|------|-------------|--------|
| `text` | `string` | Exactly `"Hello, World!"`; constant; never null or empty | FR-002 |

## Validation Rules

- `text` MUST equal the constant `"Hello, World!"` byte-for-byte (FR-002).
- Every invocation MUST return an identical `Greeting` — the entity is stateless and carries
  no identity, timestamp, or personalization (FR-003).
- No input is accepted; there are no invalid-input states (spec Edge Cases).

## Relationships

None. The feature has a single entity with no relations, no persistence, and no registry
representation.

## State Transitions

None. The greeting is immutable and stateless; there is no lifecycle.

## Storage

N/A — the entity exists only in process memory for the duration of one CLI invocation.
