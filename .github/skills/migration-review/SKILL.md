---
name: migration-review
description: "Review migrated code and tests for regressions, remaining legacy constructs, architecture problems, and missing tests. Use after a migration step and before human approval."
argument-hint: "Path to a migrated file or target module area to review"
---

# Migration Review

Use this skill after a migration step to review the target-side code with a strict code-review mindset.

## When to Use

- A migrated file and its tests have been written.
- You want to catch behavior drift before human review.
- You need a consistent checklist for migration quality.

## Review Procedure

1. Read the migrated file.
2. Read associated tests.
3. Compare the migrated behavior to the legacy source when available.
4. Check for:
   - remaining source-framework imports or annotations
   - incorrect target framework annotations or layering
   - hardcoded config values that should be externalized
   - weak or missing tests
   - obvious behavior regressions
   - awkward package placement or architecture drift
5. Return findings ordered by severity.

## Output Rules

- Findings come first.
- Prioritize bugs, regressions, and missing tests over style.
- If there are no findings, state that explicitly and mention remaining risks or test gaps.
