---
name: target-module-bootstrap
description: "Create a minimal target module for source-only legacy Java migrations. Use when no target module exists and the migration needs src/main/java, src/test/java, build files, and an application entry point."
argument-hint: "Target module path, defaulting to modern/"
---

# Target Module Bootstrap

Use this skill when the workspace contains only legacy code and you need a destination module before migrating files.

## When to Use

- No target module exists under `modern/`.
- You need a standard project skeleton for the target framework.
- You need production and test directories ready for TDD-style migration.

## Procedure

1. Search the workspace for an existing target module under `modern/`.
2. If one exists, report it and stop.
3. If none exists, scaffold a module at `modern/` using the templates in `./assets/` as a starting point.
4. Create the minimum files:
   - Build file (build.gradle or pom.xml depending on target framework)
   - Application entry point
   - `src/main/resources/application.yml` (or equivalent config)
5. Create source roots:
   - `src/main/java/<package>/`
   - `src/test/java/<package>/`
   - `src/main/resources/`
6. Ensure JUnit 5 is the default test framework.
7. Keep the scaffold intentionally small — migration-specific classes come later.

## Output Checklist

- Module root is reported.
- Files created are reported.
- Java package root is reported.
- Target framework version source is reported.
