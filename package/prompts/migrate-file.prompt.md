---
description: "Run the full migration workflow for a single legacy file: analyze, plan context, write tests, migrate, review."
---

Migrate the legacy file `${file}`.

Use the full migration workflow:

1. Check if this file is already registered in the registry. If it has status `migrated` or `reviewed`, stop and report — do not re-migrate.
2. If not yet registered, run `context-agent` to analyze and register it.
3. Run `reference-agent` to find the target framework pattern for this file's role.
4. Bootstrap `modern/` if it does not yet exist.
5. Run `migration-agent` to claim the task and execute tests-first migration.
6. Run `review-agent` to review the result.
7. If findings are narrow and safe (missing tests, annotation corrections, config externalization), run `remediation-agent` for one remediation pass and re-review once.
8. Report the final result: production path, test paths, review verdict, assumptions, and any follow-up items.
