---
name: tests-first-migration
description: "Migrate legacy Java files using a tests-first workflow. Use when target-side tests should be created before production code, especially for controllers, services, exception handlers, filters, and utilities."
argument-hint: "Legacy file path to migrate with tests-first workflow"
---

# Tests-First Migration

Use this skill when migrating a legacy Java file and you want the target-side tests created before the production code.

## When to Use

- Behavior is observable from the legacy source.
- The target file is a controller, service, exception handler, filter, utility, or model with testable behavior.
- You want migration outputs that are easier to review and safer to evolve.

## Procedure

1. Read the legacy file and extract observable behavior:
   - HTTP status and payload behavior
   - validation behavior
   - exception handling behavior
   - transformation logic
   - service branching logic
2. Choose the narrowest useful test type using [test heuristics](./references/test-heuristics.md).
3. Create target-side tests first.
4. Migrate the production code to make those tests pass.
5. Keep tests behavior-focused; do not overfit them to implementation details.
6. If behavior is ambiguous, document assumptions in the migration report.

## Rules

- Prefer unit tests over full integration tests unless framework wiring is the behavior under test.
- For controller migrations, prefer the framework's controller test slice unless deep wiring is required.
- For exception handlers, test response mapping directly.
- For utilities and pure logic classes, prefer plain unit tests.

## Output Checklist

- Tests are written before production code.
- Each test names the legacy behavior it preserves.
- Assumptions are documented.
