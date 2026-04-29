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
5. Apply the structural checklist below.
6. Return findings ordered by severity.

## Structural Checklist

Run these checks against every migrated file before closing a review.

### Test fixture placement
- No test-only class (`*TestUtil`, `*TestTransform`, `*FakeTransform`, `*ExplodingTransform`, `testdomain/**`, `*GuiceTransform`, `*BadSpec`, `*GoodTest`) should appear under `src/main/java`.
- If found: **Critical** — move to `src/test/java`.

### Stub test files
- Every `*Test.java` under `src/test/java` must contain at least one `@Test` or `@ParameterizedTest` method.
- Files with zero test annotations are **Warning** stubs and must be implemented or removed.

### Dead code
- A class in `src/main/java` with zero references across the entire `modern/` tree (excluding its own declaration) is **Critical** dead code.
- Check with: `grep -r "\b<ClassName>\b" modern/src --include="*.java" | grep -v "class <ClassName>"`

### Build dependency scope
- Any library imported **only** in `src/test/java` must be `testImplementation` (Gradle) or `<scope>test</scope>` (Maven), not `implementation`/`compile`.
- Common culprits: `guava`, `assertj`, `mockito`, `hamcrest`, `jsonassert`.

### Defensive copies on mutable input
- Methods that accept `Map`, `List`, or any mutable collection and mutate it without a defensive copy are **Critical** correctness bugs.
- Look for `// TODO: Make copy` or direct mutation of a parameter.

## Output Rules

- Findings come first.
- Prioritize correctness bugs, misplaced fixtures, and regressions over style.
- If there are no findings, state that explicitly and mention remaining risks or test gaps.
