---
description: "Review a migrated file and its tests for regressions, legacy constructs, framework correctness, and test quality."
---

Review the migrated file `${file}` and its associated tests.

1. Locate the file in `modern/` and read it.
2. Read associated tests under `src/test/java`.
3. Locate the original legacy file in `legacy/` and read it for comparison.
4. Use the `/migration-review` skill checklist.
5. Check for:
   - behavior drift from legacy
   - remaining legacy imports or annotations
   - target framework misuse
   - weak or missing tests
   - hardcoded config values
6. Write the verdict to the registry.
7. Return findings ordered by severity.
